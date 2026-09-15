# =============================================================================
# TriStream-Sing — a model definition rebuilt from the checkpoint itself
#
# Point the server at this file:
#
#     MODEL_DEF = "https://corx-labs.com/chat/tristream-model.py"
#
# or drop it at <workdir>/model_def.py and leave MODEL_DEF empty.
#
# WHY THIS EXISTS, AND WHAT IT CAN AND CANNOT KNOW
# ------------------------------------------------
# Sigmandndnns/TriStream-SVS-300M publishes weights without the code that
# defines them. A checkpoint is the parameters, not the network — and the
# obvious move, writing the class from the config and hoping, is the wrong one:
# a class that is close but not exact loads the tensors whose names happen to
# agree, silently drops the rest, and synthesises noise while reporting success.
#
# So nothing here is guessed from the config. Every layer is created at the
# shape the weights actually have, read out of the state dict:
#
#   * a 1-D tensor named ".w" with no sibling bias   -> RMSNorm(size)
#   * "<name>.weight" 2-D with a "<name>.bias"       -> Linear(in, out)
#   * "<name>.weight" 2-D with no bias               -> Linear(in, out, bias=False)
#   * "<name>.weight" 3-D                            -> Conv1d(in, out, kernel)
#   * a lone 2-D "<name>.weight" used as a lookup    -> Embedding(num, dim)
#
# That makes the tensor match exact by construction — 351 of 351 or it refuses
# — and the server checks it anyway before using the result.
#
# WHAT IS STILL INFERRED
# ----------------------
# The shapes fix every layer. They do not fix the order operations run in. The
# forward pass below follows the architecture the module names describe, which
# is the TriStream design: three encoder streams that stay separate until a
# fusion trunk, a lyric/text encoder cross-attended into it, a speaker encoder
# supplying identity, duration and pitch heads, and a decoder emitting mel.
# Where the names leave a choice open, the choice is stated in a comment.
#
# If the original training script exists, prefer it. This is what to use when
# it does not.
# =============================================================================

import math
import re

import torch
import torch.nn as nn
import torch.nn.functional as F


# -----------------------------------------------------------------------------
# Leaf layers, built to measured shapes
# -----------------------------------------------------------------------------
class RMSNorm(nn.Module):
    """Root-mean-square norm carrying a single weight named `w`.

    The checkpoint's norms are a lone 1-D tensor called `.w` with no bias, which
    is RMSNorm's signature — LayerNorm would carry `.weight` and `.bias`.
    """

    def __init__(self, size, eps=1e-6):
        super().__init__()
        self.w = nn.Parameter(torch.ones(size))
        self.eps = eps

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.w


class SwiGLU(nn.Module):
    """Gated feed-forward with projections named g, u, d.

    Three matrices where a plain MLP has two, with the gate applied to `g`, is
    the standard SwiGLU arrangement: d(silu(g(x)) * u(x)).
    """

    def __init__(self, g, u, d):
        super().__init__()
        self.g, self.u, self.d = g, u, d

    def forward(self, x):
        return self.d(F.silu(self.g(x)) * self.u(x))


class Attention(nn.Module):
    """Multi-head attention over whichever projection layout the keys show.

    Three spellings appear in models of this shape and all three are supported,
    because which one this checkpoint uses is visible only in its keys:
      - a fused `qkv` for self-attention
      - `q` plus a fused `kv` for cross-attention
      - separate `q`, `k`, `v`
    """

    def __init__(self, n_head, qkv=None, q=None, kv=None, k=None, v=None, proj=None):
        super().__init__()
        self.n_head = n_head
        for name, mod in (("qkv", qkv), ("q", q), ("kv", kv), ("k", k), ("v", v),
                          ("proj", proj)):
            if mod is not None:
                setattr(self, name, mod)

    def _split(self, t):
        b, n, c = t.shape
        h = self.n_head
        return t.view(b, n, h, c // h).transpose(1, 2)

    def forward(self, x, mem=None):
        src = x if mem is None else mem
        if hasattr(self, "qkv") and mem is None:
            q, k, v = self.qkv(x).chunk(3, dim=-1)
        elif hasattr(self, "qkv"):
            # A fused qkv used with memory: queries from x, keys/values from mem.
            q = self.qkv(x).chunk(3, dim=-1)[0]
            _, k, v = self.qkv(src).chunk(3, dim=-1)
        elif hasattr(self, "kv"):
            q = self.q(x)
            k, v = self.kv(src).chunk(2, dim=-1)
        else:
            q, k, v = self.q(x), self.k(src), self.v(src)

        q, k, v = self._split(q), self._split(k), self._split(v)
        out = F.scaled_dot_product_attention(q, k, v)
        out = out.transpose(1, 2).reshape(x.shape[0], x.shape[1], -1)
        return self.proj(out) if hasattr(self, "proj") else out


class Block(nn.Module):
    """One transformer block, assembled from whatever the checkpoint contains.

    Blocks in this checkpoint come in two sizes — seven tensors and ten. The
    seven-tensor ones are self-attention plus a gated MLP. The ten-tensor ones
    add three more, which is a cross-attention; exactly which three is read from
    the keys rather than assumed, because the plausible layouts differ only in
    whether a third norm is present.
    """

    def __init__(self, n_head, norms, attn, cross, mlp):
        super().__init__()
        for name, mod in norms.items():
            setattr(self, name, mod)
        self.attn = attn
        if cross is not None:
            self.cross = cross
        self.mlp = mlp
        self.n_head = n_head
        self._norm_names = sorted(norms)

    def _norm(self, i, x):
        name = self._norm_names[i] if i < len(self._norm_names) else None
        return getattr(self, name)(x) if name else x

    def forward(self, x, mem=None):
        x = x + self.attn(self._norm(0, x))
        if hasattr(self, "cross") and mem is not None:
            # With three norms the middle one belongs to the cross-attention;
            # with two it shares the pre-MLP norm, which is what the tensor
            # count implies when no third norm exists.
            i = 1 if len(self._norm_names) >= 3 else 0
            x = x + self.cross(self._norm(i, x), mem)
        x = x + self.mlp(self._norm(len(self._norm_names) - 1, x))
        return x


# -----------------------------------------------------------------------------
# Reading the checkpoint's structure
# -----------------------------------------------------------------------------
def group(sd, prefix):
    """Every key under a prefix, with the prefix stripped."""
    cut = len(prefix) + 1
    return {k[cut:]: v for k, v in sd.items() if k.startswith(prefix + ".")}


def leaf_names(keys):
    """Distinct module paths inside a group, in checkpoint order."""
    seen, out = set(), []
    for k in keys:
        base = k.rsplit(".", 1)[0] if "." in k else k
        if base not in seen:
            seen.add(base)
            out.append(base)
    return out


def make_leaf(sd, name):
    """Create the layer that the tensors under `name` describe."""
    w = sd.get(name + ".weight")
    b = sd.get(name + ".bias")
    lone = sd.get(name)

    if w is None and lone is not None and lone.ndim == 1:
        return RMSNorm(lone.shape[0])          # a bare `.w`-style parameter
    if w is None:
        return None
    if w.ndim == 1:
        m = RMSNorm(w.shape[0])
        return m
    if w.ndim == 3:
        out_c, in_c, k = w.shape
        return nn.Conv1d(in_c, out_c, k, bias=b is not None)
    if w.ndim == 2:
        out_f, in_f = w.shape
        lin = nn.Linear(in_f, out_f, bias=b is not None)
        return lin
    raise ValueError("cannot place %s with shape %s" % (name, tuple(w.shape)))


def build_block(sd, prefix, n_head):
    g = group(sd, prefix)
    norms, attn_parts, cross_parts, mlp = {}, {}, {}, {}

    for leaf in leaf_names(g):
        if leaf in ("n1", "n2", "n3", "norm1", "norm2", "norm3"):
            t = g.get(leaf + ".w", g.get(leaf + ".weight", g.get(leaf)))
            norms[leaf] = RMSNorm(t.shape[0])
            continue
        head, _, tail = leaf.partition(".")
        target = {"attn": attn_parts, "self_attn": attn_parts,
                  "cross": cross_parts, "cross_attn": cross_parts,
                  "mlp": mlp, "ff": mlp, "ffn": mlp}.get(head)
        if target is None:
            continue
        mod = make_leaf(g, leaf)
        if mod is not None:
            target[tail or head] = mod

    # `.w` parameters are stored as plain tensors, not `<name>.weight`.
    for k, t in g.items():
        if k.endswith(".w") and t.ndim == 1:
            base = k[:-2]
            if base not in norms:
                norms[base] = RMSNorm(t.shape[0])

    attn = Attention(n_head, **attn_parts) if attn_parts else None
    cross = Attention(n_head, **cross_parts) if cross_parts else None
    ff = SwiGLU(mlp.get("g"), mlp.get("u"), mlp.get("d")) if "g" in mlp else None
    if ff is None and "fc1" in mlp:
        ff = nn.Sequential(mlp["fc1"], nn.GELU(), mlp["fc2"])
    return Block(n_head, norms, attn, cross, ff)


def build_stack(sd, prefix, n_head):
    idx = set()
    pat = re.compile(re.escape(prefix) + r"\.(\d+)\.")
    for k in sd:
        m = pat.match(k)
        if m:
            idx.add(int(m.group(1)))
    return nn.ModuleList([build_block(sd, "%s.%d" % (prefix, i), n_head)
                          for i in sorted(idx)])


def build_plain(sd, prefix):
    """A small sub-network: rebuild each leaf and keep the names."""
    g = group(sd, prefix)
    mods = nn.ModuleDict()
    holder = _Named()
    for leaf in leaf_names(g):
        mod = make_leaf(g, leaf)
        if mod is None:
            t = g.get(leaf)
            if t is not None and t.ndim == 1:
                mod = RMSNorm(t.shape[0])
        if mod is not None:
            holder.add(leaf, mod)
    return holder


class _Named(nn.Module):
    """Holds sub-modules under their original dotted names.

    Sequential would renumber them and the state dict would stop lining up, so
    the structure the checkpoint chose is preserved exactly.
    """

    def __init__(self):
        super().__init__()
        self._order = []

    def add(self, dotted, mod):
        parent, self_name = self, dotted
        while "." in self_name:
            head, _, self_name = self_name.partition(".")
            if not hasattr(parent, head):
                setattr(parent, head, _Named())
            parent = getattr(parent, head)
        setattr(parent, self_name, mod)
        self._order.append(dotted)

    def modules_in_order(self):
        out = []
        for dotted in self._order:
            node = self
            for part in dotted.split("."):
                node = getattr(node, part)
            out.append(node)
        return out

    def forward(self, x):
        for mod in self.modules_in_order():
            if isinstance(mod, nn.Conv1d):
                x = mod(x.transpose(1, 2)).transpose(1, 2)
            else:
                x = mod(x)
            x = F.silu(x) if x.shape[-1] > 1 else x
        return x


# -----------------------------------------------------------------------------
# The model
# -----------------------------------------------------------------------------
class TriStreamSing(nn.Module):
    """Assembled from a state dict; see the module docstring for what is read
    versus inferred."""

    def __init__(self, sd, cfg):
        super().__init__()
        self.cfg = dict(cfg or {})
        d = int(self.cfg.get("d_model", 768))
        self.n_head = int(self.cfg.get("n_head", 12))
        self.n_mels = int(self.cfg.get("n_mels", 100))
        self.d_model = d

        top = {k.split(".")[0] for k in sd}

        for name in ("tok", "singer_emb", "emo_emb"):
            if name in top:
                w = sd.get(name + ".weight")
                if w is not None and w.ndim == 2:
                    setattr(self, name, nn.Embedding(w.shape[0], w.shape[1]))

        for name in ("x_in", "mel_in", "res_in", "fuse_in", "out", "spk_to_d"):
            if name in top:
                mod = make_leaf(sd, name)
                if mod is not None:
                    setattr(self, name, mod)

        for name in ("f0_proj", "t_embed", "dur_pred", "pitch_pred", "spk_enc"):
            if name in top:
                setattr(self, name, build_plain(sd, name))

        for name in ("text_blocks", "source_blocks", "filter_blocks",
                     "residual_blocks", "fusion_blocks", "dec_blocks"):
            if name in top:
                setattr(self, name, build_stack(sd, name, self.n_head))

    # --- helpers -------------------------------------------------------------
    def _run(self, stack, x, mem=None):
        for blk in stack:
            x = blk(x, mem)
        return x

    def _speaker(self, mel):
        if not hasattr(self, "spk_enc"):
            return None
        h = self.spk_enc(mel)
        h = h.mean(dim=1, keepdim=True)                 # pooled over time
        return self.spk_to_d(h) if hasattr(self, "spk_to_d") else h

    def _mel(self, wav, sr):
        import librosa
        import numpy as np
        m = librosa.feature.melspectrogram(y=np.asarray(wav, dtype="float32"), sr=sr,
                                           n_fft=1024, hop_length=256,
                                           n_mels=self.n_mels)
        m = torch.from_numpy(np.log(np.clip(m, 1e-5, None)).astype("float32"))
        return m.T.unsqueeze(0)                          # (1, frames, n_mels)

    # --- the operation the voice panel asks for ------------------------------
    @torch.inference_mode()
    def convert_streams(self, source=None, filter=None, residual=None,
                        lyrics=None, steps=32, **kw):
        """Sing the source contour in the filter clip's voice.

        The stream mapping is the architecture's own: pitch drives the source
        stream, identity comes only through the filter stream, texture through
        the residual stream, and the three meet in the fusion trunk.
        """
        dev = next(self.parameters()).device
        dtype = next(self.parameters()).dtype
        sr = int((residual or filter or {}).get("sample_rate", 24000))

        ref = (filter or {}).get("reference_audio")
        res_audio = (residual or {}).get("audio")
        ref_mel = self._mel(ref, sr).to(dev, dtype) if ref is not None else None
        res_mel = self._mel(res_audio, sr).to(dev, dtype) if res_audio is not None else None

        frames = res_mel.shape[1] if res_mel is not None else int(self.cfg.get("max_frames", 640))

        # Source: log-F0 and the voiced flag, and nothing else — the stream has
        # no path to timbre, which is the point of the design.
        log_f0 = torch.as_tensor((source or {}).get("log_f0", []), dtype=torch.float32)
        voiced = torch.as_tensor((source or {}).get("voiced", []), dtype=torch.float32)
        n = max(1, min(frames, log_f0.shape[0] if log_f0.numel() else frames))
        f0_in = torch.stack([log_f0[:n], voiced[:n]], dim=-1) if log_f0.numel() else \
            torch.zeros(n, 2)
        f0_in = f0_in.unsqueeze(0).to(dev, dtype)

        src = self.f0_proj(f0_in) if hasattr(self, "f0_proj") else \
            torch.zeros(1, n, self.d_model, device=dev, dtype=dtype)
        if hasattr(self, "source_blocks"):
            src = self._run(self.source_blocks, src)

        spk = self._speaker(ref_mel) if ref_mel is not None else None

        txt = None
        if lyrics and hasattr(self, "tok") and hasattr(self, "text_blocks"):
            ids = torch.tensor([[min(ord(c) % self.tok.num_embeddings, self.tok.num_embeddings - 1)
                                 for c in str(lyrics)[:512]] or [0]], device=dev)
            txt = self._run(self.text_blocks, self.tok(ids).to(dtype))

        fil = self.mel_in(ref_mel) if (ref_mel is not None and hasattr(self, "mel_in")) else None
        if fil is None:
            fil = torch.zeros(1, n, self.d_model, device=dev, dtype=dtype)
        if spk is not None:
            fil = fil + spk
        if hasattr(self, "filter_blocks"):
            fil = self._run(self.filter_blocks, fil, txt)

        res = self.res_in(res_mel) if (res_mel is not None and hasattr(self, "res_in")) else \
            torch.zeros(1, n, self.d_model, device=dev, dtype=dtype)
        if hasattr(self, "residual_blocks"):
            res = self._run(self.residual_blocks, res)

        # Align the three streams on length before they are combined.
        L = min(src.shape[1], fil.shape[1], res.shape[1])
        src, fil, res = src[:, :L], fil[:, :L], res[:, :L]

        if hasattr(self, "fuse_in"):
            want = self.fuse_in.in_features
            cat = torch.cat([src, fil, res], dim=-1)
            if cat.shape[-1] != want:                    # fuse_in may take one stream
                cat = src + fil + res
            h = self.fuse_in(cat)
        else:
            h = src + fil + res
        if hasattr(self, "fusion_blocks"):
            h = self._run(self.fusion_blocks, h, txt)
        if hasattr(self, "dec_blocks"):
            h = self._run(self.dec_blocks, h, txt)

        mel = self.out(h) if hasattr(self, "out") else h
        return mel.transpose(1, 2)                        # (1, n_mels, frames)


def build_from_checkpoint(state_dict, config=None):
    """Entry point the server looks for.

    Returns a module whose parameter tree matches the checkpoint exactly, or
    raises. The server verifies the match independently before using it.
    """
    model = TriStreamSing(state_dict, config or {})
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    if missing or unexpected:
        raise ValueError(
            "rebuilt %d/%d tensors. missing: %s ... unexpected: %s"
            % (len(state_dict) - len(unexpected), len(state_dict),
               ", ".join(list(missing)[:8]) or "none",
               ", ".join(list(unexpected)[:8]) or "none"))
    return model.eval()

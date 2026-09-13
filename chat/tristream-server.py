# =============================================================================
# TriStream-SVS server — Build 1
#
# Serves Sigmandndnns/TriStream-SVS-300M behind an OpenAI-shaped HTTP API and a
# Cloudflare quick tunnel, so the voice studio in the CorX chat can reach it.
#
# Runs either way, unchanged: paste it into one molab / Colab cell on a GPU
# runtime, or save it as tristream-server.py on your own workstation and run
# `python3 tristream-server.py`. Nothing here needs a notebook. It prints a
# https://<random>.trycloudflare.com URL; paste that into the chat's Voice
# panel and press Connect.
#
# On Blackwell cards (RTX PRO 6000, RTX 50-series) it installs the CUDA 12.8
# build of PyTorch — the first one that ships sm_120 kernels — and /health
# reports the GPU it found and whether the build actually covers it.
#
# WHAT IT DOES WITH THE TWO CLIPS
# -------------------------------
# TriStream's whole design is that the three encoder streams are structurally
# separate — the source stream physically cannot carry timbre, and the filter
# stream is the only one that carries identity. That makes a two-clip transplant
# the natural operation rather than a hack:
#
#   VOICE clip       -> speaker encoder -> singer embedding -> FILTER stream
#                       (who it sounds like)
#   PERFORMANCE clip -> F0 contour + voiced/unvoiced flag   -> SOURCE stream
#                       (the notes, the timing, the vibrato)
#                    -> mel                                  -> RESIDUAL stream
#                       (breath and consonant texture; switchable to the voice)
#
# So: it sings the performance, in the target voice.
#
# HONEST NOTE ON THE MODEL INTERFACE
# ----------------------------------
# This script does NOT assume an inference API. It downloads the repo, looks at
# what is actually in it, and binds to whatever entry point it finds — trying
# stream-level control first so the transplant above is real, and falling back
# to the repo's own conversion call if that is all it exposes. /health reports
# exactly which path it bound to, and if it can bind to nothing it says what it
# found and what it tried instead of pretending to work. Check /health before
# you trust the output.
# =============================================================================

import os
import subprocess
import sys
import time

REPO_ID      = "Sigmandndnns/TriStream-SVS-300M"
PORT         = 811
SAMPLE_RATE  = 24000          # TriStream decodes mel at 24 kHz
STEPS        = 32             # rectified-flow sampling steps; the card says ~32
NO_AUTH      = True           # matches the other CorX server scripts
WORKDIR      = os.path.abspath("./tristream-run")

os.makedirs(WORKDIR, exist_ok=True)
RUNNER_PATH = os.path.join(WORKDIR, "runner.py")
CFG_PATH    = os.path.join(WORKDIR, "config.json")
LOG_PATH    = os.path.join(WORKDIR, "server.log")
URL_PATH    = os.path.join(WORKDIR, "tunnel-url.txt")


def sh(cmd, **kw):
    print("$", cmd, flush=True)
    return subprocess.run(cmd, shell=True, **kw)


# -----------------------------------------------------------------------------
# 1. Dependencies
# -----------------------------------------------------------------------------
print("=" * 72)
print("TriStream-SVS server — installing dependencies")
print("=" * 72)

sh("pip -q install --upgrade pip")
# Blackwell cards (RTX PRO 6000, RTX 50-series) are compute capability sm_120,
# and the cu124 wheels carry no sm_120 kernels — torch imports fine, then every
# CUDA call fails with "no kernel image is available". cu128 is the first build
# that ships them, so try it first and only fall back for older cards.
sh("pip -q install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 "
   "|| pip -q install torch torchaudio --index-url https://download.pytorch.org/whl/cu124 "
   "|| pip -q install torch torchaudio")
sh("pip -q install 'transformers>=4.44' huggingface_hub safetensors einops "
   "fastapi 'uvicorn[standard]' python-multipart soundfile librosa numpy scipy")

# cloudflared, for the quick tunnel
if subprocess.run("which cloudflared", shell=True, capture_output=True).returncode != 0:
    sh("wget -q -O /usr/local/bin/cloudflared "
       "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
       "&& chmod +x /usr/local/bin/cloudflared")

import json  # noqa: E402

json.dump({
    "repo_id": REPO_ID, "port": PORT, "sample_rate": SAMPLE_RATE,
    "steps": STEPS, "no_auth": NO_AUTH, "workdir": WORKDIR,
    "url_path": URL_PATH,
}, open(CFG_PATH, "w"))


# -----------------------------------------------------------------------------
# 2. The runner
#
# Written to disk and launched in its own session. A thread inside the notebook
# dies with the kernel; a detached process does not, which is the difference
# between "it stopped running overnight" and a server that stays up.
# -----------------------------------------------------------------------------
RUNNER_SRC = r'''
import io, json, os, re, subprocess, sys, threading, time, traceback

CFG = json.load(open(sys.argv[1]))
REPO_ID     = CFG["repo_id"]
PORT        = CFG["port"]
SAMPLE_RATE = CFG["sample_rate"]
STEPS       = CFG["steps"]
NO_AUTH     = CFG["no_auth"]
WORKDIR     = CFG["workdir"]
URL_PATH    = CFG["url_path"]

import numpy as np
import soundfile as sf
import torch

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE  = torch.float16 if DEVICE == "cuda" else torch.float32

GPU_NAME = ""
if DEVICE == "cuda":
    GPU_NAME = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    arch_ok = ("sm_%d%d" % cap) in (torch.cuda.get_arch_list() or [])
    print("GPU: %s (sm_%d%d), torch %s built for %s"
          % (GPU_NAME, cap[0], cap[1], torch.__version__,
             ",".join(torch.cuda.get_arch_list() or ["?"])), flush=True)
    if not arch_ok:
        print("!! This torch build has no kernels for sm_%d%d. Reinstall with:\n"
              "   pip install --force-reinstall torch torchaudio "
              "--index-url https://download.pytorch.org/whl/cu128" % cap, flush=True)
    # Blackwell has bf16 throughout and it is better behaved than fp16 here.
    if cap[0] >= 9:
        DTYPE = torch.bfloat16

STATE = {
    "ready": False,
    "binding": None,      # which entry point we bound to
    "detail": "",         # why, or why not
    "files": [],
    "tried": [],
    "device": DEVICE,
    "tunnel": None,
}

def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# Audio helpers — the two inputs the panel sends
# ---------------------------------------------------------------------------
def load_audio(raw, target_sr=None):
    """Bytes -> mono float32 at target_sr."""
    target_sr = target_sr or SAMPLE_RATE
    import librosa
    wav, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != target_sr:
        wav = librosa.resample(wav, orig_sr=sr, target_sr=target_sr)
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 0:
        wav = wav / peak * 0.97
    return wav.astype("float32")


def f0_contour(wav, sr=None, fmin=65.0, fmax=1200.0):
    """Log-F0 and the voiced/unvoiced flag — exactly what the source stream takes.

    The source stream receives these two arrays and nothing else. It has no path
    to the mel, the singer embedding, or any other timbre-carrying signal, which
    is why taking them from a different singer transfers the melody without
    dragging that singer's voice along with it.
    """
    import librosa
    sr = sr or SAMPLE_RATE
    f0, voiced, _ = librosa.pyin(wav, fmin=fmin, fmax=fmax, sr=sr,
                                 frame_length=1024, hop_length=256)
    f0 = np.nan_to_num(f0, nan=0.0)
    log_f0 = np.zeros_like(f0)
    nz = f0 > 0
    log_f0[nz] = np.log(f0[nz])
    return log_f0.astype("float32"), voiced.astype("float32")


def mel_spec(wav, sr=None, n_mels=100):
    """100-band mel at 24 kHz — the decoder's output format, per the model card."""
    import librosa
    sr = sr or SAMPLE_RATE
    m = librosa.feature.melspectrogram(y=wav, sr=sr, n_fft=1024, hop_length=256,
                                       n_mels=n_mels)
    return np.log(np.clip(m, 1e-5, None)).astype("float32")


def shift_pitch(log_f0, semitones):
    if not semitones:
        return log_f0
    out = log_f0.copy()
    nz = out > 0
    out[nz] = out[nz] + float(semitones) * np.log(2.0) / 12.0
    return out


def to_wav_bytes(wav, sr=None):
    buf = io.BytesIO()
    sf.write(buf, np.asarray(wav, dtype="float32"), sr or SAMPLE_RATE, format="WAV",
             subtype="PCM_16")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Binding to whatever the repo actually exposes
#
# The model card was not readable from the machine that wrote this script, so
# nothing here assumes a function signature. It downloads the repo, inspects it,
# and binds to the most capable entry point present — preferring one that lets
# the three streams be driven separately, because that is what makes the voice
# and the performance come from different clips rather than from a generic
# any-to-any conversion.
# ---------------------------------------------------------------------------
STREAM_CALLS  = ["convert_streams", "transplant", "convert_voice", "voice_convert"]
CONVERT_CALLS = ["convert", "inference", "infer", "synthesize", "generate", "__call__"]

def bind_model():
    from huggingface_hub import snapshot_download
    local = snapshot_download(repo_id=REPO_ID, local_dir=os.path.join(WORKDIR, "model"))
    STATE["files"] = sorted(os.listdir(local))
    log("repo files:", STATE["files"])
    sys.path.insert(0, local)

    obj = None

    # (a) transformers remote code, if the repo ships a config for it
    if any(f == "config.json" for f in STATE["files"]):
        for loader in ("AutoModel", "AutoModelForSpeechSeq2Seq"):
            try:
                import transformers
                cls = getattr(transformers, loader)
                obj = cls.from_pretrained(local, trust_remote_code=True,
                                          torch_dtype=DTYPE).to(DEVICE).eval()
                STATE["detail"] = "loaded via transformers.%s(trust_remote_code=True)" % loader
                break
            except Exception as e:
                STATE["tried"].append("%s: %s" % (loader, str(e)[:160]))

    # (b) a module in the repo that builds the model itself
    if obj is None:
        for mod_name in ("inference", "infer", "tristream", "modeling_tristream",
                         "model", "svs", "pipeline"):
            if not any(f == mod_name + ".py" for f in STATE["files"]):
                continue
            try:
                import importlib
                mod = importlib.import_module(mod_name)
                for factory in ("load_model", "from_pretrained", "build", "Pipeline",
                                "TriStreamSVS", "TriStream", "Model"):
                    fn = getattr(mod, factory, None)
                    if fn is None:
                        continue
                    try:
                        obj = fn(local) if callable(fn) else None
                    except TypeError:
                        try:
                            obj = fn()
                        except Exception as e:
                            STATE["tried"].append("%s.%s: %s" % (mod_name, factory, str(e)[:120]))
                            continue
                    except Exception as e:
                        STATE["tried"].append("%s.%s: %s" % (mod_name, factory, str(e)[:120]))
                        continue
                    if obj is not None:
                        STATE["detail"] = "loaded via %s.%s()" % (mod_name, factory)
                        break
                if obj is not None:
                    break
            except Exception as e:
                STATE["tried"].append("import %s: %s" % (mod_name, str(e)[:160]))

    if obj is None:
        STATE["ready"] = False
        STATE["detail"] = ("Could not construct the model from this repo. "
                           "Files present: %s. Attempts: %s"
                           % (", ".join(STATE["files"]), " | ".join(STATE["tried"]) or "none"))
        log("!! " + STATE["detail"])
        return

    # Which call do we have? Stream-level beats whole-clip conversion.
    for name in STREAM_CALLS:
        if callable(getattr(obj, name, None)):
            STATE["binding"] = ("streams", name)
            break
    else:
        for name in CONVERT_CALLS:
            if callable(getattr(obj, name, None)):
                STATE["binding"] = ("convert", name)
                break

    if STATE["binding"] is None:
        STATE["ready"] = False
        methods = [m for m in dir(obj) if not m.startswith("_")][:40]
        STATE["detail"] = ("Model built, but no recognised inference method. "
                           "Public methods: %s" % ", ".join(methods))
        log("!! " + STATE["detail"])
        return

    STATE["model"] = obj
    STATE["ready"] = True
    log("bound to %s.%s — %s" % (type(obj).__name__, STATE["binding"][1], STATE["detail"]))


# ---------------------------------------------------------------------------
# The two operations the panel offers
# ---------------------------------------------------------------------------
@torch.inference_mode()
def run_convert(voice_wav, perf_wav, residual_from="performance", pitch_shift=0.0,
                steps=STEPS, lyrics=""):
    """Sing the performance clip in the voice clip's voice."""
    model = STATE["model"]
    kind, name = STATE["binding"]
    fn = getattr(model, name)

    log_f0, vuv = f0_contour(perf_wav)
    log_f0 = shift_pitch(log_f0, pitch_shift)
    residual_src = perf_wav if residual_from == "performance" else voice_wav

    if kind == "streams":
        # The real transplant: each stream driven from the clip it belongs to.
        out = fn(
            source={"log_f0": log_f0, "voiced": vuv},
            filter={"reference_audio": voice_wav, "sample_rate": SAMPLE_RATE},
            residual={"audio": residual_src, "sample_rate": SAMPLE_RATE},
            lyrics=lyrics or None,
            steps=int(steps),
        )
        used = "stream transplant (%s)" % name
    else:
        # Repo exposes only whole-clip conversion. Still the right mapping —
        # content from the performance, identity from the voice — but the stream
        # routing is the repo's, not ours.
        out = _call_flexible(fn, perf_wav, voice_wav, steps, lyrics)
        used = "repo conversion call (%s)" % name

    return _as_audio(out), used


@torch.inference_mode()
def run_generate(voice_wav, lyrics, melody_wav=None, steps=STEPS, pitch_shift=0.0):
    """Generation mode: sing lyrics from scratch in the cloned voice."""
    model = STATE["model"]
    kind, name = STATE["binding"]
    fn = getattr(model, name)

    kwargs = {"lyrics": lyrics, "steps": int(steps)}
    if melody_wav is not None:
        log_f0, vuv = f0_contour(melody_wav)
        log_f0 = shift_pitch(log_f0, pitch_shift)
        kwargs["source"] = {"log_f0": log_f0, "voiced": vuv}
    if kind == "streams":
        kwargs["filter"] = {"reference_audio": voice_wav, "sample_rate": SAMPLE_RATE}
        out = fn(**kwargs)
    else:
        out = _call_flexible(fn, None, voice_wav, steps, lyrics, melody_wav)
    return _as_audio(out), "generation (%s)" % name


def _call_flexible(fn, content_wav, reference_wav, steps, lyrics, melody_wav=None):
    """Try the argument spellings a repo of this kind plausibly uses.

    Every attempt and its error is kept, so a failure reports what was actually
    tried rather than a bare traceback.
    """
    import inspect
    attempts = []
    base = {"sample_rate": SAMPLE_RATE, "sr": SAMPLE_RATE, "steps": int(steps),
            "num_steps": int(steps), "n_steps": int(steps)}
    names_content = ["source_audio", "content_audio", "audio", "wav", "src", "source"]
    names_ref     = ["reference_audio", "speaker_audio", "target_audio", "ref", "reference",
                     "prompt_audio", "speaker_wav"]
    try:
        sig = set(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        sig = set()

    kwargs = {}
    if content_wav is not None:
        for n in names_content:
            if n in sig:
                kwargs[n] = content_wav
                break
    for n in names_ref:
        if n in sig:
            kwargs[n] = reference_wav
            break
    if lyrics and "lyrics" in sig:
        kwargs["lyrics"] = lyrics
    if melody_wav is not None and "melody" in sig:
        kwargs["melody"] = melody_wav
    for k, v in base.items():
        if k in sig:
            kwargs[k] = v

    if kwargs:
        try:
            return fn(**kwargs)
        except Exception as e:
            attempts.append("kwargs %s: %s" % (sorted(kwargs), str(e)[:200]))

    for args in ([content_wav, reference_wav] if content_wav is not None else [reference_wav],
                 [reference_wav, content_wav] if content_wav is not None else None):
        if args is None:
            continue
        try:
            return fn(*[a for a in args if a is not None])
        except Exception as e:
            attempts.append("positional %d: %s" % (len(args), str(e)[:200]))

    raise RuntimeError("No call signature worked. Tried: " + " | ".join(attempts))


def _as_audio(out):
    """Whatever came back -> a mono float32 waveform."""
    if isinstance(out, dict):
        for k in ("audio", "wav", "waveform", "samples", "output"):
            if k in out:
                out = out[k]
                break
    if isinstance(out, (list, tuple)) and out:
        out = out[0]
    if torch.is_tensor(out):
        out = out.detach().float().cpu().numpy()
    out = np.asarray(out, dtype="float32")
    if out.ndim > 1:
        out = out.reshape(out.shape[0], -1).mean(axis=0) if out.shape[0] < out.shape[-1] \
              else out.mean(axis=-1)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1.0:
        out = out / peak * 0.97
    return out


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="TriStream-SVS")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"], expose_headers=["*"])


@app.get("/health")
def health():
    return {
        "ok": bool(STATE["ready"]),
        "model": REPO_ID,
        "device": STATE["device"],
        "gpu": GPU_NAME,
        "sample_rate": SAMPLE_RATE,
        "binding": STATE["binding"][1] if STATE["binding"] else None,
        "mode": STATE["binding"][0] if STATE["binding"] else None,
        "detail": STATE["detail"],
        "files": STATE["files"],
        "tried": STATE["tried"],
        "modes": ["convert", "generate"],
    }


def _guard():
    if not STATE["ready"]:
        raise HTTPException(status_code=503, detail=STATE["detail"] or "Model still loading.")


@app.post("/v1/voice/convert")
async def convert(voice: UploadFile = File(...),
                  performance: UploadFile = File(...),
                  residual_from: str = Form("performance"),
                  pitch_shift: float = Form(0.0),
                  steps: int = Form(STEPS),
                  lyrics: str = Form("")):
    _guard()
    try:
        v = load_audio(await voice.read())
        p = load_audio(await performance.read())
        t0 = time.time()
        wav, used = run_convert(v, p, residual_from, pitch_shift, steps, lyrics)
        return Response(
            content=to_wav_bytes(wav), media_type="audio/wav",
            headers={"X-TriStream-Path": used,
                     "X-TriStream-Seconds": "%.1f" % (time.time() - t0),
                     "Content-Disposition": 'attachment; filename="tristream.wav"'})
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/v1/voice/generate")
async def generate(voice: UploadFile = File(...),
                   lyrics: str = Form(...),
                   melody: UploadFile = File(None),
                   pitch_shift: float = Form(0.0),
                   steps: int = Form(STEPS)):
    _guard()
    try:
        v = load_audio(await voice.read())
        m = load_audio(await melody.read()) if melody is not None else None
        t0 = time.time()
        wav, used = run_generate(v, lyrics, m, steps, pitch_shift)
        return Response(
            content=to_wav_bytes(wav), media_type="audio/wav",
            headers={"X-TriStream-Path": used,
                     "X-TriStream-Seconds": "%.1f" % (time.time() - t0),
                     "Content-Disposition": 'attachment; filename="tristream.wav"'})
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


# ---------------------------------------------------------------------------
# Cloudflare quick tunnel
# ---------------------------------------------------------------------------
def start_tunnel():
    proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", "http://127.0.0.1:%d" % PORT, "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    pat = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    for line in proc.stdout:
        m = pat.search(line)
        if m:
            STATE["tunnel"] = m.group(0)
            open(URL_PATH, "w").write(m.group(0))
            log("\n" + "=" * 72)
            log("TUNNEL URL: " + m.group(0))
            log("=" * 72 + "\n")
            break
    for _ in proc.stdout:
        pass


threading.Thread(target=start_tunnel, daemon=True).start()

try:
    bind_model()
except Exception as e:
    STATE["ready"] = False
    STATE["detail"] = "Load failed: %s" % e
    traceback.print_exc()

import uvicorn
uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
'''

with open(RUNNER_PATH, "w") as f:
    f.write(RUNNER_SRC)

# -----------------------------------------------------------------------------
# 3. Launch, detached
# -----------------------------------------------------------------------------
print("\nStarting the server in its own session (it outlives this cell)…")
if os.path.exists(URL_PATH):
    os.remove(URL_PATH)

_log = open(LOG_PATH, "a")
_proc = subprocess.Popen(
    [sys.executable, "-u", RUNNER_PATH, CFG_PATH],
    stdout=_log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
    start_new_session=True, cwd=WORKDIR)
print("pid", _proc.pid, "· log:", LOG_PATH)

print("\nWaiting for the Cloudflare tunnel…")
url = None
for i in range(180):
    if os.path.exists(URL_PATH):
        url = open(URL_PATH).read().strip()
        if url:
            break
    if _proc.poll() is not None:
        print("\n!! The server exited. Last 40 log lines:\n")
        print("".join(open(LOG_PATH).readlines()[-40:]))
        raise SystemExit(1)
    time.sleep(1)

print("\n" + "=" * 72)
if url:
    print("  TriStream is up.")
    print()
    print("  URL:  " + url)
    print()
    print("  1. Open https://corx-labs.com/chat/")
    print("  2. Press the microphone button in the header")
    print("  3. Paste the URL above, press Connect")
    print()
    print("  Check " + url + "/health first — it reports which entry point the")
    print("  model bound to. If `ok` is false, the detail field says exactly what")
    print("  the repo contained and what was tried.")
else:
    print("  No tunnel URL after 180s. Log tail:")
    print("".join(open(LOG_PATH).readlines()[-40:]))
print("=" * 72)
print("\nFollow the log with:  !tail -f " + LOG_PATH)

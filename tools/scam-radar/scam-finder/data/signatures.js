// Fingerprints of known scam kits: software that many scam sites are stamped out from
// A rule tests one part of a page profile; a kit matches when its rules reach `threshold`
//
// Rule fields: `on` is what to test (html | title | text | url | root | paths | ogSpoof,
// or a `behaviour` / `forms` flag by name), `match` is the pattern, `weight` is how much it
// counts (default 1) and `note` is the plain-English evidence shown when the rule fires
// `pivots` are searches known to surface more copies of the kit
// `lureOnAnyPath` says the kit shows its current lure whatever path is asked for, so a
// made-up path reveals what a confirmed copy is promoting today
//
// Found a new kit? Add it here. Pick markers that are odd enough not to occur by accident

export const SIGNATURES = [
  {
    id: 'whatsapp-brand-gift',
    name: 'WhatsApp chain "brand gift" kit',
    category: 'giveaway',
    description:
      "Fake anniversary or holiday giveaways in a well-known brand's name. Victims answer a " +
      'short quiz, "win", then must forward the link to WhatsApp contacts to claim. The kit ' +
      'hides from desktop browsers and rotates through throwaway domains.',
    threshold: 2,
    rules: [
      {
        on: 'paths',
        match: /^\/metaconfig\/images\//i,
        weight: 2,
        note: 'Serves its preview image from /metaconfig/images/',
      },
      {
        on: 'html',
        match: /\/404bbb\$\{/,
        note: 'Script sends desktop visitors to a /404bbb… dead end',
      },
      {
        on: 'root',
        match: /^[a-z]{0,6}404code[a-z0-9]{0,24}$/,
        weight: 2,
        note: 'Front page answers with the kit\'s "404code…" stub',
      },
      {
        on: 'ogSpoof',
        match: /(^|\.)whatsapp\.com$/,
        note: 'Link preview claims the page is whatsapp.com',
      },
      {
        on: 'title',
        match: /\b(gift|anniversary|subsidy|free\s+(data|internet))\b.{0,12}$/i,
        note: 'Title promises a gift, subsidy or free data',
      },
      {
        on: 'url',
        match: /[?&]s=(wa|ms|fb|tg|ig)(&|$)/,
        note: "Link carries the kit's share-source tag (s=wa, s=ms…)",
      },
    ],
    pivots: [{ type: 'filename', value: 'metaconfig/images/en/01.jpg' }],
    lureOnAnyPath: true,
  },
  {
    id: 'share-to-claim',
    name: 'Share-to-claim survey chain',
    category: 'giveaway',
    description:
      'A prize is promised, but only after sharing the page with a set number of contacts or ' +
      'groups. No prize exists; the sharing is how the scam spreads.',
    threshold: 2,
    rules: [
      {
        on: 'text',
        match: /share (it |this )?(with|to) \d+ (friends|groups|contacts)/i,
        weight: 2,
        note: 'Tells visitors to share with a set number of friends or groups',
      },
      {
        on: 'text',
        match:
          /(congratulations|felicidades|parabéns|selamat)[!.]? .{0,80}(won|selected|chosen|ganaste|ganhou)/i,
        note: 'Congratulates the visitor on winning',
      },
      {
        on: 'text',
        match: /\b(questionnaire|survey)\b.{0,120}\b(gift|prize|reward)\b/i,
        note: 'Offers a prize for answering a survey',
      },
      {
        on: 'behaviour',
        match: 'whatsappShare',
        note: 'Script opens WhatsApp to forward the link',
      },
      {
        on: 'text',
        match: /only \d+ (gifts|prizes|rewards) (left|remaining)/i,
        note: 'Fake countdown of remaining prizes',
      },
    ],
    pivots: [],
  },
  {
    id: 'telegram-exfil-phish',
    name: 'Credential phishing kit (Telegram drop)',
    category: 'phishing',
    description:
      'A fake sign-in or payment form whose script sends whatever is typed to a Telegram bot.',
    threshold: 2,
    rules: [
      {
        on: 'html',
        match: /api\.telegram\.org\/bot\d{6,12}:/,
        weight: 2,
        note: 'Script posts form data to a Telegram bot',
      },
      { on: 'forms', match: 'passwordFields', note: 'Has a password field' },
      { on: 'forms', match: 'cardFields', note: 'Asks for payment card details' },
    ],
    pivots: [],
  },
  {
    id: 'clickfix',
    name: 'ClickFix fake verification',
    category: 'malware',
    description:
      'A fake CAPTCHA or error page that copies a command to the clipboard and talks the ' +
      'visitor into running it, which installs malware.',
    threshold: 3,
    rules: [
      { on: 'behaviour', match: 'clipboardWrite', note: 'Script writes to the clipboard' },
      {
        on: 'html',
        match: /powershell|mshta|cmd(\.exe)?\s+\/c|curl\s+-[a-z]*s[a-z]*\s+https?:/i,
        weight: 2,
        note: 'Page contains a system command to run',
      },
      {
        on: 'text',
        match: /(press|hold).{0,20}(win(dows)?\s*\+\s*r|⊞)|verify you are human/i,
        note: 'Walks the visitor through a fake "verify you are human" step',
      },
    ],
    pivots: [],
  },
  {
    id: 'tech-support-lock',
    name: 'Tech-support scare page',
    category: 'tech-support',
    description:
      'A full-screen fake virus warning that traps the browser and tells the visitor to phone ' +
      'a "support" number.',
    threshold: 3,
    rules: [
      {
        on: 'text',
        match:
          /(virus|trojan|spyware|malware).{0,60}(detected|found|alert)|(computer|pc|device).{0,30}(locked|blocked|infected)/i,
        weight: 2,
        note: 'Claims the device is infected or locked',
      },
      {
        on: 'text',
        match: /call.{0,40}(support|microsoft|windows|apple|toll.?free|helpline)/i,
        note: 'Pushes a "support" phone number',
      },
      { on: 'behaviour', match: 'fullscreenLock', note: 'Forces the browser into full screen' },
      { on: 'behaviour', match: 'backButtonTrap', note: 'Hijacks the back button' },
    ],
    pivots: [],
  },
  {
    id: 'wallet-drainer',
    name: 'Crypto wallet drainer',
    category: 'crypto',
    description:
      'A fake airdrop, mint or claim page that asks the visitor to connect a wallet and sign ' +
      'approvals that empty it.',
    threshold: 3,
    rules: [
      {
        on: 'text',
        match: /\b(claim|check eligibility|connect wallet|mint now)\b/i,
        note: 'Urges the visitor to claim or connect a wallet',
      },
      {
        on: 'text',
        match: /\b(airdrop|presale|allocation|staking rewards|token claim)\b/i,
        note: 'Advertises an airdrop, presale or token claim',
      },
      {
        on: 'html',
        match: /walletconnect|web3modal|ethers(\.min)?\.js|wagmi|@reown/i,
        note: 'Loads wallet-connection code',
      },
      {
        on: 'html',
        match: /setApprovalForAll|increaseAllowance|permit2|seaport|eth_signTypedData/i,
        weight: 2,
        note: 'Script requests token approvals or signatures',
      },
    ],
    pivots: [],
  },
  {
    id: 'advance-fee',
    name: 'Lottery or advance-fee pitch',
    category: 'lottery',
    description:
      'A page announcing winnings, an inheritance or a compensation payment that can only be ' +
      'released after paying a fee or handing over personal details.',
    threshold: 3,
    rules: [
      {
        on: 'text',
        match: /\b(lottery|lotto|sweepstakes?|jackpot|mega millions|powerball)\b/i,
        note: 'Mentions a lottery or sweepstakes',
      },
      {
        on: 'text',
        match:
          /\b(you (have|'ve) won|winning (notification|ticket|number)|lucky winner|beneficiary|unclaimed)\b/i,
        weight: 2,
        note: 'Tells the visitor they have won or are a beneficiary',
      },
      {
        on: 'text',
        match: /\b(processing|clearance|delivery|handling|transfer|tax) fee\b/i,
        weight: 2,
        note: 'Asks for a fee before paying out',
      },
      {
        on: 'text',
        match:
          /\b(claim(s)? (agent|officer|department)|fiduciary agent|compensation (fund|payment))\b/i,
        note: 'Refers to a claims agent or compensation fund',
      },
    ],
    pivots: [],
  },
];

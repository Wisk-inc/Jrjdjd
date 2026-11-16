// Hunt profiles: saved searches that pull fresh leads out of the public scan archive
// Each query returns candidates only. Plenty will be honest sites that happen to match,
// so every lead is then scored on its own evidence before anything is called a scam
//
// Queries use urlscan.io search syntax and stay within what works without an API key
// (no regular expressions, no leading wildcards). `keywords` are matched against the
// blocklist feeds. `targets` keeps only leads aimed at those countries, when set

const not = (domains) => ` AND NOT page.apexDomain:(${domains.join(' OR ')})`;

const JAMAICA_OFFICIAL = [
  'jncb.com',
  'jnbank.com',
  'jngroup.com',
  'jmmb.com',
  'sagicor.com',
  'digicelgroup.com',
  'digicelplus.com',
  'supremeventures.com',
  'gracekennedy.com',
  'gracefoods.com',
  'discoverflow.co',
  'jpsco.com',
  'lynk.us',
];

export const PROFILES = {
  jamaica: {
    name: 'Jamaica-targeted scams',
    description:
      'Fake giveaways, bank and utility phishing, and lottery pitches aimed at people in ' +
      'Jamaica or trading on Jamaican brands. A site is never suspect for being Jamaican: ' +
      'leads come from what a page claims to be, and are scored on their own evidence.',
    queries: [
      {
        q: `page.domain:(jncb* OR ncbjamaica* OR ncb-jamaica* OR jnbank* OR jmmb* OR digicel* OR supremeventures* OR gracekennedy* OR jamaicatax* OR jamaicapost* OR jpsco*)${not(JAMAICA_OFFICIAL)}`,
        why: 'Hostnames that start with a Jamaican brand name but are not the brand',
      },
      {
        q: `page.title:("National Commercial Bank" OR "NCB Online" OR "JN Bank" OR "JMMB" OR "Supreme Ventures" OR "Jamaica Post" OR "Tax Administration Jamaica" OR "Lynk" OR "Digicel")${not(JAMAICA_OFFICIAL)}`,
        why: 'Pages titled after a Jamaican bank, telecom or agency on someone else’s domain',
      },
      {
        q: 'page.title:(jamaica OR jamaican) AND page.title:(gift OR giveaway OR prize OR winner OR lottery OR grant OR subsidy OR claim OR reward OR verify OR login)',
        why: 'Pages pairing "Jamaica" with prize, grant or sign-in wording',
      },
      {
        q: 'page.title:("Heroes Day" OR "Emancipation Day" OR "Independence Day") AND page.title:(gift OR giveaway OR subsidy OR reward)',
        why: 'Holiday giveaway lures (the WhatsApp chain kits reuse national holidays)',
      },
      {
        q: 'filename:"metaconfig/images/en/01.jpg"',
        why: 'The WhatsApp "brand gift" kit, kept only where the lure targets Jamaica',
        targetsOnly: true,
      },
    ],
    keywords: [
      'jncb',
      'ncbjamaica',
      'jnbank',
      'jmmb',
      'digicel',
      'supremeventures',
      'gracekennedy',
      'jamaica',
    ],
    targets: ['JM'],
  },

  'whatsapp-giveaway': {
    name: 'WhatsApp chain giveaways',
    description:
      'Fake brand anniversaries, holiday gifts, free mobile data and "government subsidy" ' +
      'pages that spread by making each victim forward the link.',
    queries: [
      {
        q: 'filename:"metaconfig/images/en/01.jpg"',
        why: 'Kit file served by every copy of the "brand gift" kit',
      },
      {
        q: 'page.title:("Gift!" OR "anniversary gift" OR "Anniversary Celebration" OR "free internet" OR "free data") AND page.domainAgeDays:<60',
        why: 'Giveaway titles on domains under two months old',
      },
      {
        q: 'page.title:(subsidy OR "relief fund" OR "cash gift" OR "government grant") AND page.domainAgeDays:<60',
        why: 'Fake subsidy and relief-fund titles on young domains',
      },
    ],
    keywords: [],
  },

  lottery: {
    name: 'Lottery and advance-fee pitches',
    description:
      'Winnings, inheritances and compensation payments that need a fee or personal details ' +
      'up front. The classic phone-and-mail lottery scam, in web form.',
    queries: [
      {
        q: 'page.title:(lottery OR lotto OR sweepstakes OR jackpot) AND page.title:(winner OR winners OR claim OR won OR notification) AND page.domainAgeDays:<180',
        why: 'Lottery-winner titles on young domains',
      },
      {
        q: 'page.title:("Publishers Clearing House" OR "PCH" OR "Mega Millions" OR "Powerball") AND page.title:(winner OR claim OR prize) AND NOT page.apexDomain:(pch.com OR megamillions.com OR powerball.com)',
        why: 'Well-known sweepstakes names on domains that are not theirs',
      },
      {
        q: 'page.title:("compensation fund" OR "unclaimed funds" OR "inheritance fund" OR "claim your prize" OR "prize claim")',
        why: 'Advance-fee wording in the page title',
      },
    ],
    keywords: [
      'lottery',
      'lotto',
      'sweepstake',
      'jackpot',
      'pchwinner',
      'megamillion',
      'powerball',
    ],
  },

  'bank-phishing': {
    name: 'Bank and payment phishing',
    description: 'Fake sign-in and "verify your account" pages for banks and payment services.',
    queries: [
      {
        q: 'page.title:("verify your account" OR "account suspended" OR "account verification" OR "secure login" OR "online banking login") AND page.domainAgeDays:<90',
        why: 'Account-verification titles on domains under three months old',
      },
      {
        q: 'task.tags:phishing AND page.title:(bank OR banking OR paypal OR card)',
        why: 'Scans tagged as phishing by submitters',
      },
    ],
    keywords: ['secure-login', 'verify-account', 'account-verify', 'onlinebanking'],
  },

  delivery: {
    name: 'Parcel and delivery fee scams',
    description: 'Fake courier pages asking for a small "redelivery" or customs payment.',
    queries: [
      {
        q: 'page.title:(parcel OR package OR delivery OR shipment) AND page.title:(redelivery OR "on hold" OR pending OR customs OR "track your") AND page.domainAgeDays:<60',
        why: 'Delivery-problem titles on young domains',
      },
      {
        q: 'page.domain:(usps* OR dhl-* OR fedex-* OR royalmail* OR evri-*) AND page.domainAgeDays:<60',
        why: 'Courier names at the start of a young hostname',
      },
    ],
    keywords: ['redelivery', 'usps', 'parcel-', 'royalmail', 'dhl-'],
  },

  crypto: {
    name: 'Crypto drainers and fake investments',
    description: 'Fake airdrops, wallet "verification" pages and guaranteed-return platforms.',
    queries: [
      {
        q: 'page.title:(airdrop OR "claim rewards" OR "connect wallet" OR presale) AND page.domainAgeDays:<45',
        why: 'Airdrop and claim titles on domains under six weeks old',
      },
      {
        q: 'task.tags:(drainer OR "crypto-phishing" OR walletdrainer)',
        why: 'Scans tagged as wallet drainers',
      },
    ],
    keywords: ['airdrop', 'claim-', 'walletconnect', 'metamask', 'trustwallet'],
  },

  'tech-support': {
    name: 'Tech-support scare pages',
    description: 'Fake virus alerts that lock the browser and push a "support" phone number.',
    queries: [
      {
        q: 'page.title:("virus detected" OR "security alert" OR "windows defender" OR "your computer is infected" OR "system warning")',
        why: 'Scareware wording in the page title',
      },
      {
        q: 'task.tags:(techsupportscam OR "tech-support-scam" OR tss)',
        why: 'Scans tagged as tech-support scams',
      },
    ],
    keywords: [],
  },

  'government-benefit': {
    name: 'Fake grants and benefits',
    description: 'Pages impersonating government relief, stimulus or grant programmes.',
    queries: [
      {
        q: 'page.title:("relief fund" OR "government grant" OR "stimulus payment" OR "cash transfer" OR "empowerment fund" OR "social grant") AND page.domainAgeDays:<90',
        why: 'Grant and relief wording on domains under three months old',
      },
    ],
    keywords: ['relief-fund', 'govgrant', 'stimulus', 'subsidy'],
  },
};

export const PROFILE_IDS = Object.keys(PROFILES);

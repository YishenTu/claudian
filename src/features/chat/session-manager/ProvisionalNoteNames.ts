import * as Obsidian from 'obsidian';

const UNTITLED_NOTE_NAMES: Readonly<Record<string, string>> = {
  af: 'Untitled',
  am: 'ርዕስ አልባ',
  ar: 'بدون عنوان',
  az: 'Untitled',
  be: 'Без назвы',
  bg: 'Без заглавие',
  bn: 'নামহীন',
  ca: 'Sense títol',
  cs: 'Bez názvu',
  da: 'Unavngivet',
  de: 'Unbenannt',
  dv: 'Untitled',
  el: 'Χωρίς Τίτλο',
  en: 'Untitled',
  'en-GB': 'Untitled',
  eo: 'Untitled',
  es: 'Sin título',
  eu: 'Untitled',
  fa: 'بی‌نام',
  fi: 'Nimetön',
  fr: 'Sans titre',
  ga: 'Gan teideal',
  gl: 'Untitled',
  he: 'ללא כותרת',
  hi: 'Untitled',
  hr: 'Bez naslova',
  hu: 'Névtelen',
  id: 'Tanpa judul',
  it: 'Senza nome',
  ja: '無題のファイル',
  ka: 'უსათაურო',
  kab: 'War azwel',
  kh: 'គ្មានចំណងជើង',
  kn: 'Untitled',
  ko: '무제',
  ky: 'Untitled',
  la: 'Untitled',
  lt: 'Untitled',
  lv: 'Bez nosaukuma',
  ml: 'Untitled',
  ms: 'Tak bertajuk',
  'nan-TW': 'Bô miâ-tshing tóng-àn',
  ne: 'शीर्षकविहीन',
  nl: 'Naamloos',
  nn: 'Untitled',
  no: 'Uten tittel',
  oc: 'Untitled',
  or: 'Untitled',
  pl: 'Bez nazwy',
  pt: 'Sem título',
  'pt-BR': 'Sem título',
  ro: 'Fără titlu',
  ru: 'Без названия',
  sa: 'अनशीर्षकम्',
  si: 'මාතෘකාවක් නොමැති (Untitled)',
  sk: 'Bez názvu',
  sl: 'Neimenovano',
  sq: 'I paemërtuar',
  sr: 'Без наслова',
  sv: 'Namnlös',
  sw: 'Untitled',
  ta: 'தலைப்பில்லாதது',
  te: 'Untitled',
  th: 'ยังไม่ได้ตั้งชื่อ',
  tl: 'Untitled',
  tr: 'Başlıksız',
  tt: 'Untitled',
  uk: 'Без назви',
  ur: 'Untitled',
  uz: 'Nomlanmagan',
  vi: 'Chưa đặt tên',
  zh: '未命名',
  'zh-TW': '未命名',
};

const UNTITLED_NOTE_NAMES_BY_LOWERCASE_LOCALE = new Map(
  Object.entries(UNTITLED_NOTE_NAMES).map(([locale, title]) => [locale.toLowerCase(), title]),
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getUntitledNoteName(language: string): string {
  const normalizedLanguage = language.trim().toLowerCase();
  return UNTITLED_NOTE_NAMES_BY_LOWERCASE_LOCALE.get(normalizedLanguage)
    ?? UNTITLED_NOTE_NAMES_BY_LOWERCASE_LOCALE.get(normalizedLanguage.split('-')[0])
    ?? UNTITLED_NOTE_NAMES.en;
}

export function getObsidianLanguage(fallbackLanguage = 'en'): string {
  const getLanguage = (Obsidian as unknown as Record<string, unknown>)['getLanguage'];
  return typeof getLanguage === 'function'
    ? (getLanguage as () => string)()
    : fallbackLanguage;
}

export function isProvisionalNotePath(notePath: string, language: string): boolean {
  const filename = notePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const basename = filename.replace(/\.md$/i, '');
  const untitledName = getUntitledNoteName(language);
  return new RegExp(`^${escapeRegExp(untitledName)}(?: \\d+)?$`).test(basename);
}

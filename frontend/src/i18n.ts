let currentLocale = 'en-US';

export function setLocale(loc: string): void {
  currentLocale = loc;
}

export function getLocale(): string {
  return currentLocale;
}

export function isZh(): boolean {
  return currentLocale === 'zh-CN';
}

export function t(zh: string, en: string): string {
  return isZh() ? zh : en;
}

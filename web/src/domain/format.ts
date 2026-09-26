export const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);

export const kb = (n: number | null | undefined): string | number =>
  n === null || n === undefined ? "?" : Math.round(n / 1024);

export const pngDataUrl = (b64: string): string =>
  `data:image/png;base64,${b64}`;

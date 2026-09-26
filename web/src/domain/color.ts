const RGB = /rgb\((\d+),(\d+),(\d+)\)/;

export const luminance = (css: string | null): number | null => {
  const m = css?.match(RGB);
  if (!m) {
    return null;
  }
  const [r, g, b] = m.slice(1).map(Number) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

/** 濃淡: 輝度から求めた濃度(0%=白, 100%=黒)を5%刻みで丸める */
export const shade = (css: string | null): string | null => {
  const y = luminance(css);
  return y === null ? null : `濃度${Math.round((1 - y / 255) * 20) * 5}%`;
};

// 1ページ分の切り出しは直近 capacity 件を使い回す(同時の要求でも1回だけ作るよう Promise を持つ)
import type { PageBody } from "./pdf";

export type PageBodySource = (page: number) => Promise<PageBody>;

export const createPageBodyCache = (
  extract: PageBodySource,
  capacity: number
): PageBodySource => {
  // Map の挿入順を LRU の順序として使う(このクロージャの外からは見えない)
  const cache = new Map<number, Promise<PageBody>>();
  return (n) => {
    const hit = cache.get(n);
    if (hit) {
      cache.delete(n);
      cache.set(n, hit);
      return hit;
    }
    const p = extract(n);
    p.catch(() => cache.delete(n));
    cache.set(n, p);
    while (cache.size > capacity) {
      cache.delete(cache.keys().next().value as number);
    }
    return p;
  };
};

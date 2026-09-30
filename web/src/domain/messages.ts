// 画面に出す文言のうち、状態から組み立てるもの
import type { ItemType } from "./constants";
import { mb } from "./format";
import type { CalibrationMethod } from "./types";

/** 凡例の種類ごとの補足(マウスオーバー) */
export const TYPE_LABELS: Readonly<Record<ItemType, string>> = {
  curve: "曲線(ベジェ曲線を含む)",
  fill: "塗りつぶし(図形の塗りの範囲。種類の色で半透明に表示)",
  image: "PDFに埋め込まれた画像",
  line: "直線",
  rect: "矩形",
  text: "文字(単語単位)",
};

const CALIBRATION_NOTES: Readonly<Record<CalibrationMethod, string>> = {
  fallback_disabled: "補正は無効です",
  fallback_no_samples:
    "実測に使える孤立した直線が少なく、算出できませんでした(補正なし)",
  manual: "手動で指定された係数です",
  measured: "原本画像から孤立した直線の太さを実測して算出しました",
};

export interface StatusText {
  readonly text: string;
  readonly tip: string | null;
}

export const plainStatus = (text: string): StatusText => ({ text, tip: null });

/** 線幅補正の係数。算出できなかった場合(補正なし)は「-」とし、詳細はマウスオーバーで補足する */
export const calibrationStatus = (
  method: CalibrationMethod,
  scale: number
): StatusText => {
  const valid = method === "measured" || method === "manual";
  return {
    text: `線幅補正 ${valid ? `×${scale}` : "-"}`,
    tip: `PDFが報告する線幅を、実際に描画される太さへ合わせる係数(描画太さ = 線幅 × 係数)。\n${CALIBRATION_NOTES[method] ?? ""}`,
  };
};

export const pageInfoText = (page: number, total: number): string =>
  `${page + 1} / ${total} ページ`;

export const tooLargeMessage = (bytes: number, limit: number): string =>
  `このページはデータが大きく(${mb(bytes)}MB、上限${mb(limit)}MB)処理できません`;

export const thumbUnavailableTip = (page: number): string =>
  `${page + 1}ページ(サムネイルを表示できません)`;

export const opacityTip = (v: number): string =>
  `元PDFをそのまま描画した原本画像の濃さ(現在 ${v}%)。検出結果と重ねて比較するための下敷きです`;

export const legendTypeTip = (type: ItemType, count: number): string =>
  `${TYPE_LABELS[type]}の表示/非表示(${count}件)`;

export const thumbToggleLabel = (visible: boolean): string =>
  visible ? "サムネイル一覧を閉じる" : "サムネイル一覧を開く";

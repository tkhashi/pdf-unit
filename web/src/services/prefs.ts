// 閲覧者ごとの表示設定(ブラウザの localStorage。使えない環境では既定値)
const THUMBS_KEY = "pdf-unit.thumbs";

export const loadThumbsPref = (): boolean => {
  try {
    return localStorage.getItem(THUMBS_KEY) !== "hidden";
  } catch {
    return true;
  }
};

export const saveThumbsPref = (visible: boolean): void => {
  try {
    localStorage.setItem(THUMBS_KEY, visible ? "shown" : "hidden");
  } catch {
    // 保存できなくても表示は切り替える
  }
};

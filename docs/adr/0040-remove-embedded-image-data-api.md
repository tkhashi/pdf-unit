# ADR 0040: 埋め込み画像の画像データの API を削除する

- ステータス: 採用([0026](0026-embedded-image-png-on-demand.md)・[0032](0032-embedded-images-batch-api.md) の API を廃止)
- 日付: 2026-09-26

## コンテキスト

ADR 0039 で、UI は埋め込み画像の画像データを取得せず、配置範囲の枠と原本画像で表示するようになりました。`/api/page/images/{k}`(ADR 0026)と `/api/page/images?start=&count=`(ADR 0032)は UI から使われなくなり、ユーザーの判断で削除することにしました。

## 決定

- `server.py` から `/api/page/images/{k}`・`/api/page/images` と、それ専用の処理(PNG の縮小 `_downscale_png`、まとめ取得の件数の定数)を削除する。削除したパスへの要求は 404 になる
- `raster.py` の `extract_images` は、配置情報(`ImageRecord` のリスト)だけを返す。PNG 化の経路(`png_indices`・`pngs`)と、バイト列を受け取る `extract_page_images` を削除する
- 画像データの取り出し(`get_bitmap`)は残す。取り出せない画像は飛ばして番号を詰めており(ADR 0026)、省くと `/api/page/lines` が返す画像と番号が変わるため。取り出した bitmap はその場で閉じる
- `scripts/profile_pages.py` から `images` の計測(`--endpoints` の `images`、`--max-images`)を削除する
- E2E の並走比較では、旧UI が要求する `/api/page/images` をサーバーが 404 で返す。画像の範囲の画素と、通信の `/api/page/images` は ADR 0039 のとおり比較から外している

## 理由

- 使われない API を残すと、保守の手間と攻撃面が増えるため
- `/api/page/lines` の応答は変わらない。実PDF(大判図面1ページ・軽量図面5ページ)で、削除の前後の応答がバイト単位で一致することを確かめた

## 影響

- `/api/page/lines` の計測区間 `images` の内訳は `images.decode` だけになる(`images.png` は削除前から `/api/page/lines` では出ていなかった)
- 画像データが必要になった場合は、ADR 0032 のまとめ取得 API を git の履歴から戻せる

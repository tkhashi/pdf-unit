# ADR 0021: アプリの CI が Lambda のコードと静的ファイルを直接更新し、infra は入れ物だけを作る

- ステータス: 採用(動作確認の `GET /vendor/pdf-lib.min.js` は [0029](0029-build-artifacts-and-deploy.md) で `index.html` が参照する `assets/` の確認に置き換え。CI が UI をビルドする手順を追加)
- 日付: 2026-09-26

## コンテキスト

GitHub Actions で自動デプロイしたいという要件があった。条件は次のとおり。

- `pdf-unit` の `main` にマージされたら自動で反映する(承認は挟まない)
- `pdf-unit.infra` の変更はトリガーにしない。infra は自動デプロイせず、手動で反映する
- 両リポジトリともプライベート

それまでは両リポジトリとも CI が無く、手元で `pdf-unit.infra` の `cdk deploy`(IAM ユーザーの長期アクセスキー)を実行していた。infra の CDK スタックは、隣に置いた `../pdf-unit` から uv で Lambda の zip を組み立て(`python-bundling.ts`)、`BucketDeployment` で静的ファイルを S3 に置いていた。つまり、アプリをデプロイする処理そのものが infra 側にあった。

## 検討した案

1. **アプリの CI が infra を読んで `cdk deploy` する**: 既存の仕組みをそのまま使えるが、CI がプライベートな infra リポジトリを読むための鍵が必要になる。また `cdk deploy` はスタック全体を反映するため、手動で反映していない infra の変更までアプリのマージで反映されてしまう(infra の版を固定する運用が必要)。CI のロールにも CDK 用の強い権限が要る
2. **アプリの CI が Lambda のコードと静的ファイルだけを直接更新する(採用)**
3. **コンテナイメージにする**: アプリ側で Lambda Web Adapter を含む arm64 イメージを作って ECR に置く。サイズ上限が 10GB になり手元と同じイメージで動かせるが、ECR・arm64 のビルド環境が増え、コールドスタートも遅くなりやすい。現状の zip(24MB、展開後 66MB)は zip の上限(直接アップロード 50MB、展開後 250MB)に十分収まるので、利点がまだ効かない

## 決定

- **infra は「入れ物」だけを作る**: S3・Lambda・Function URL・CloudFront・GitHub Actions 用の OIDC ロール。Lambda は infra リポジトリ内の仮のコード(`placeholder/`、`GET /` に 200、それ以外に 503 を返す)で作成する。Python のバンドル処理と `BucketDeployment` は infra から削除した
  - CloudFormation は、テンプレート上のコードの識別子(アセットのハッシュ)が変わったときだけ関数のコードを更新する。仮のコードを変えなければ、infra を再デプロイしても CI が入れたアプリのコードは上書きされない。仮のコードを変えると次の infra のデプロイでアプリが仮のコードに戻るため、変更しない(変えた場合はデプロイ直後にアプリのワークフローを手動実行する)
- **アプリの CI(`.github/workflows/deploy.yml`)**: `main` への push と手動実行で動く
  1. `scripts/build_lambda.sh` で zip を組み立てる(従来の infra のバンドル処理と同じ手順を、アプリ側1か所にまとめた。手元でも使える)
  2. OIDC でロールを引き受ける
  3. `aws lambda update-function-code` → `aws lambda wait function-updated-v2`
  4. `aws s3 sync --delete` → CloudFront の `/*` を無効化して完了を待つ
  5. `scripts/smoke_test.sh` で公開URLを確認する(`GET /`・`GET /vendor/pdf-lib.min.js`・SHA-256 付きの `POST /api/page/lines`・ヘッダー無しの POST が 403)
  - Lambda を先に、静的ファイルを後に更新する(新しい画面が古い API を呼ばないように)。`concurrency` で同時実行させず、実行中のものは取り消さない
- **AWS 認証は OIDC**: GitHub に長期のアクセスキーを置かない。ロールの信頼条件は `repo:tkhashi/pdf-unit:ref:refs/heads/main` だけで、権限はこの関数のコード更新(`lambda:UpdateFunctionCode`・`GetFunction`・`GetFunctionConfiguration`)、このバケットへの配置(`s3:ListBucket`・`PutObject`・`DeleteObject`)、この配信の無効化(`cloudfront:CreateInvalidation`・`GetInvalidation`)に限る
  - GitHub Environment は使わない。指定すると OIDC トークンの `sub` が `repo:<repo>:environment:<name>` に変わり、信頼条件と一致しなくなる
- **アプリのリポジトリが持つインフラ情報**
  - コミットするもの: infra との約束事(Python 3.13・arm64・zip 直下の `run.sh`・ポート 8080・`GET /` の起動確認)を `build_lambda.sh` と README に明記する
  - リポジトリ変数(秘密ではない識別子): `AWS_REGION`・`AWS_DEPLOY_ROLE_ARN`・`LAMBDA_FUNCTION_NAME`・`SITE_BUCKET_NAME`・`DISTRIBUTION_ID`・`SITE_URL`(値は infra の出力)。Secrets は不要。アカウントIDも伏せたい場合だけロールARNを Secrets に置ける
  - 持たないもの: 認証情報、CDK のコード、infra リポジトリへの参照、リソースの定義(メモリ量・タイムアウト・CloudFront の構成など)

## 理由

- zip の組み立て手順がアプリ側1か所になり、infra と CI の2か所で手順がずれる問題が起きない
- CI は infra を参照しないので、プライベートリポジトリ間の鍵が不要になり、infra の未反映の変更が紛れ込むこともない
- CI のロールが操作できるのは、この3リソースの中身だけになる。CDK のロールを引き受けないので、IAM やリソースの設定は変更できない
- infra のデプロイに uv もアプリのリポジトリも不要になり、「隣に置く」前提(`appPath`)が消える

## 影響

- infra を新規に作った直後や、初めてこの方式に移行するときは、アプリの CI が1回走るまで API が 503 になる
- CloudFormation のドリフト検出では、Lambda のコードが定義と異なる状態として表示される(想定どおり)
- 反映は Lambda → 静的ファイルの順なので、数十秒は新旧が混在する
- Lambda の実行環境(Python の版・アーキテクチャ・起動方法)を変えるときは、アプリと infra の両方を変更する必要がある
- 検証: zip は 24MB(展開後 66MB)で、同梱のネイティブライブラリはすべて aarch64。Lambda の公式ベースイメージ(`public.ecr.aws/lambda/python:3.13`、arm64)の中で `run.sh` を起動し、`GET /` と `POST /api/page/lines` が手元と同じ結果になることを確認した

## 追記(2026-09-26): OIDC の `sub` の形式

初回の Deploy は、ロールを引き受ける段階で `Not authorized to perform sts:AssumeRoleWithWebIdentity` になった。このリポジトリは GitHub の OIDC で不変の識別子(`use_immutable_subject`)を使う設定のため、トークンの `sub` は `repo:tkhashi/pdf-unit:ref:refs/heads/main` ではなく、オーナーとリポジトリの数値IDを含む `repo:tkhashi@66816003/pdf-unit@1386009673:ref:refs/heads/main` だった。

「このリポジトリの main からだけ引き受けられる」という決定は変えず、infra のロールの信頼条件をIDを含む形式に合わせた(pdf-unit.infra の `githubRepoOwnerId`・`githubRepoId`)。IDで照合するので、リポジトリ名を変えたり同名のリポジトリを作り直したりしても、なりすましは起きない。GitHub 側のこの設定は変更しないこと(変えると信頼条件と一致しなくなる)。

# サードパーティーと外部サービス

Spoon Manager 本体の独自コードは [MIT License](LICENSE) で公開します。第三者のソフトウェア・データ・商標に、この MIT ライセンスを適用するものではありません。

## ビルドと配布に使用する部品

| 部品 | バージョン | ライセンス・条件 | 用途 |
| --- | --- | --- | --- |
| [nlohmann/json](https://github.com/nlohmann/json/tree/v3.11.3) | 3.11.3 | MIT | JSON 処理 |
| [cpp-httplib](https://github.com/yhirose/cpp-httplib/tree/v0.18.3) | 0.18.3 | MIT | ローカル HTTP サーバー |
| [Microsoft WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35) | 1.0.4314.35 | SDK に付属する Microsoft のライセンス | 画面表示と静的ローダー |
| [cloudflared](https://github.com/cloudflare/cloudflared/tree/2026.10.7) | 2026.10.7 | Apache-2.0。実行ファイルに含まれる依存部品には各部品の条件も適用 | 一時参加 URL を公開する別プロセス |
| [NSIS](https://nsis.sourceforge.io/License) | 3.11（自動取得時） | zlib/libpng、bzip2、CPL-1.0 等。付属の COPYING を参照 | インストーラー作成 |
| Microsoft Visual C++ Runtime | 使用するビルド環境に依存 | Microsoft の再配布条件 | ネイティブアプリの実行 |
| [jsdom](https://github.com/jsdom/jsdom/tree/24.1.3) | 24.1.3 | MIT。間接依存は各パッケージのライセンス | 開発時の UI テストのみ |

依存部品、ダウンロードした SDK、ビルド済み実行ファイル、ランタイム DLL はソースリポジトリに含めません。ビルドでは固定 URL と SHA-256 で主要な取得物を検証します。jsdom の間接依存は [package-lock.json](package-lock.json) で固定します。

バイナリを配布する場合は、本体の LICENSE と第三者のライセンス・著作権表示を保持してください。現在の CMake のインストール処理は nlohmann/json、cpp-httplib、WebView2、cloudflared のライセンスを licenses/ に配置します。バイナリ公開時には、cloudflared の間接依存や上流の NOTICE、および使用した NSIS・Microsoft ランタイムの再配布条件も確認してください。

Microsoft Edge WebView2 Evergreen Runtime は利用者が別途導入します。

## 外部サービス・音声・データ

- Spoon API の利用には、Spoon の利用規約、開発者向け条件、利用者の同意が適用されます。本体の MIT ライセンスは API の利用許諾や Spoon の商標使用許諾を与えるものではありません。
- VOICEVOX、選択した音声ライブラリ・話者、tts.quest の利用条件やクレジット表記は、それぞれの提供元の条件に従ってください。音声エンジンや音声モデルを本リポジトリで配布するものではありません。
- Open-Meteo、GeoNames、国土地理院のデータには、それぞれの利用条件と出典表示の条件が適用されます。商用利用や API 利用枠についても各提供元の条件を確認してください。
- Cloudflare のトンネルサービス利用には、ソフトウェアの Apache-2.0 ライセンスとは別に、サービスの利用条件が適用されます。

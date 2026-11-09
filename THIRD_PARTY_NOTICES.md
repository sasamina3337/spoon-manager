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

インストーラーと ZIP は、本体の LICENSE と第三者のライセンス・著作権表示を同梱します。CMake は nlohmann/json、cpp-httplib、WebView2 SDK のライセンスと NOTICE、cloudflared の Apache-2.0 ライセンス、および [licenses/](licenses/) 内の文書を配置します。

## v2.8.0 のバイナリ配布で確認した条件

- **nlohmann/json と cpp-httplib**: MIT の著作権表示・許諾文・免責文を保持します。nlohmann/json に同梱される Hedley などの著作権表示も `nlohmann-json-components.txt` に収録します。
- **WebView2 SDK**: 取得した SDK の LICENSE.txt と NOTICE.txt をそのまま同梱します。ブラウザー本体は配布せず、[Microsoft の配布ガイド](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) に従って Evergreen Runtime を事前条件にしています。
- **cloudflared**: 公式配布の Windows amd64 バイナリを改変せず、固定 SHA-256 を照合して使用します。ビルド情報に記録された実際の 66 モジュール（置換先を含む）について、Go 公式モジュールプロキシのソース ZIP を取得し、バイナリに記録された Go モジュールの h1 チェックサムを照合しました。各モジュール内の LICENSE・COPYING・NOTICE・著作権表示・PATENTS 等を `cloudflared-dependencies.txt` に保持し、取得 URL・バージョン・チェックサム・収録ファイルを `cloudflared-dependencies.json` に記録しています。cloudflared 自体の上流タグには独立した NOTICE ファイルはありません。
- **Go ランタイム**: cloudflared が使用した Go 1.27.3 の公式ソースにあるライセンス・特許許諾・第三者表示を `go-runtime.txt` に保持します。ビルドツールや未使用のソース部品の表示も含むため、表示範囲は実際にリンクされた部分より広くなっています。
- **NSIS 3.11**: 取得した配布物の COPYING 全文を `nsis.txt` に保持します。LZMA 圧縮モジュールの CPL-1.0 には、リンクするアプリのコードを CPL の対象にしない特別例外が付属しています。NSIS 自体や圧縮モジュールの改変は行っていません。[上流のソース・ライセンス](https://nsis.sourceforge.io/License) も参照してください。
- **Microsoft Visual C++ Runtime**: 正規にライセンスされた Visual Studio の利用を前提に、[Visual Studio 2026 の再配布可能リスト](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution) に記載された VC/Redist 配下の Release DLL のみを、無改変でアプリと同梱します。Debug DLL や開発ツールは配布しません。Microsoft のソフトウェアに本体の MIT を適用するものではありません。

jsdom・Node.js・CMake・コンパイラーはバイナリ配布物に含めません。依存を更新した場合は、この確認とライセンス文書の収集を更新してください。

Microsoft Edge WebView2 Evergreen Runtime は利用者が別途導入します。

## 外部サービス・音声・データ

- Spoon API の利用には、Spoon の利用規約、開発者向け条件、利用者の同意が適用されます。本体の MIT ライセンスは API の利用許諾や Spoon の商標使用許諾を与えるものではありません。
- VOICEVOX、選択した音声ライブラリ・話者、tts.quest の利用条件やクレジット表記は、それぞれの提供元の条件に従ってください。音声エンジンや音声モデルを本リポジトリで配布するものではありません。
- Open-Meteo、GeoNames、国土地理院のデータには、それぞれの利用条件と出典表示の条件が適用されます。商用利用や API 利用枠についても各提供元の条件を確認してください。
- Cloudflare のトンネルサービス利用には、ソフトウェアの Apache-2.0 ライセンスとは別に、サービスの利用条件が適用されます。

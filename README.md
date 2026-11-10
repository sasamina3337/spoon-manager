# Spoon Manager

Spoon の公式APIでコメントを受信し、読み上げ、集計、質問受付、投票、ゲーム、自動応答を行うWindowsアプリです。C++20 / Win32 / WebView2を使用します。

## ダウンロードと起動

[GitHub Releases](https://github.com/sasamina3337/spoon-manager/releases) から Windows x64 向けの配布物を取得してください。

| 配布物 | 使い方 |
| --- | --- |
| `SpoonManager-2.8.1-win64-Setup.exe` | 1ファイルのインストーラー。実行してインストールします。 |
| `SpoonManager-2.8.1-win64.zip` | 全体を展開し、フォルダー内の `SpoonManager.exe` を起動します。 |
| `SHA256SUMS.txt` | ダウンロードしたインストーラーと ZIP の SHA-256 一覧です。 |

どちらも [Microsoft Edge WebView2 Evergreen Runtime（x64）](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) が必要です。インストーラーは未導入なら案内して終了し、ランタイムの自動インストールは行いません。

アプリ本体は画面ファイル、DLL、Cloudflare の補助 EXE と一緒に動作します。`SpoonManager.exe` だけを取り出して実行する形式にはしていません。ZIP はフォルダー構成と `licenses/` を保持してください。配布物には認証情報、設定、利用記録、開発用依存、Debug DLL を含めません。

Spoon の開発者登録・API 認証設定は各利用者が用意してください。音声サービスや外部 API の利用条件は [サードパーティーと外部サービス](THIRD_PARTY_NOTICES.md) を参照してください。

## 開発環境

Windows x64、Microsoft C++ Build Tools（C++ によるデスクトップ開発）、Windows SDK、CMake 4.2 以降、Visual Studio 2026 が必要です。Visual Studio に付属するツールも利用できます。起動には Microsoft Edge WebView2 Evergreen Runtime が必要です。

## VS Code

推奨拡張の C/C++ と CMake Tools を有効にしてください。フォルダーを開くと CMake が構成され、選択中のプリセットのヘッダー、定義、コンパイルオプションが IntelliSense に渡されます。

- F5: Debug をビルドしてデバッグを開始します。
- Ctrl+Shift+B: Debug をビルドします。
- テストエクスプローラー: CTest で検出されたテストを実行します。初回はビルドが必要です。
- 「タスクの実行 → テスト」: Debug ビルド後にテストを実行します。
- 「タスクの実行 → Release ビルド」: 配布用の構成をビルドします。

設定は [.vscode](.vscode/)、構成は [CMakePresets.json](CMakePresets.json) にあります。windows-debug / windows-release を選択できます。

## コマンド

PowerShell で実行します。

~~~powershell
.\spoon.ps1 build
.\spoon.ps1 test
.\spoon.ps1 start
.\spoon.ps1 build --debug
.\spoon.ps1 start --debug
~~~

既定は Release です。build はアプリとインストーラーを作成し、dist/spoon-manager/ に配布ファイルを配置します。実行ファイルは SpoonManager.exe、インストーラーは dist/installers/SpoonManager-2.8.1-win64-Setup.exe です。実行ファイルと ui/、ランタイム DLL を一緒に配置してください。

JavaScript の画面ロジックをテストするときだけ Node.js が必要です。

~~~powershell
npm ci
npm run test:ui
~~~

アプリのビルド・起動にはNode.jsは不要です。一時参加URLの公開に使うCloudflareの実行ファイルは、固定バージョンとSHA-256を検証して同梱します。

Release 構成では、インストーラーに使用した同じ配布用ファイルから `dist/releases/SpoonManager-2.8.1-win64.zip` も作成します。第三者のライセンスと NOTICE も両方に同梱します。

## 機能と保存データ

テーマは「設定 → 表示」で選択でき、即時反映・自動保存されます。「設定 → コマンド」では各コマンドを個別に ON／OFF にして「設定を保存」で反映できます。OFF のコマンドは処理と返信を停止し、ヘルプ一覧にも保存済みの状態を表示します。

受信開始時に、すべてのSpoon API権限の同意をまとめて確認します。既存の同意に不足がある場合は同意画面を開き、完了後に受信を自動開始します。開発者センターにも全権限を登録してください。必要な権限の一覧は「設定 → 連携 → 開発者センターに登録する権限」に表示します。各機能のON/OFFは同意と独立して設定できます。

リダイレクトURIは `http://localhost:17864/oauth/callback`（ポートを変更した場合はその値）です。認証後のアプリへの復帰と認証タブの自動閉鎖は「API連携・起動時の設定」で指定でき、既定で有効です。ブラウザーが自動閉鎖を許可しない場合は、認証完了画面からタブを閉じてください。

対応機能は [FEATURES.md](FEATURES.md)、コマンドの対応状況は [COMMANDS.md](COMMANDS.md)、構成と検証方法は [開発ガイド](native/README.md) を参照してください。

設定と記録の保存先は互換性のため従来どおり %APPDATA%/Spoon Manager Desktop/ です。起動時の --data-dir で変更できます。認証情報や保存データは配布物へ含めません。

## ライセンス

Spoon Manager 本体の独自コードは [MIT License](LICENSE) です。著作権表示とライセンス本文を保持すれば、商用利用・改変・再配布ができます。

依存部品と外部サービスには、それぞれのライセンス・利用条件が適用されます。[サードパーティーと外部サービス](THIRD_PARTY_NOTICES.md) を参照してください。

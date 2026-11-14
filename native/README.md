# 開発ガイド

アプリ本体は C++20 / Win32 / WebView2 で構成します。画面は [desktop/renderer](../desktop/renderer/)、本体は [native/src](src/)、ヘッダーは [native/include](include/)、テストは [native/tests](tests/) にあります。

## ビルドとデバッグ

[CMakePresets.json](../CMakePresets.json) の windows-debug / windows-release を使います。ビルド先は .local/build/ 以下です。VS Code の CMake Tools が構成、ビルド、テスト検出、IntelliSense への情報提供を担当します。F5 の起動前タスクは Debug 構成とビルドを実行し、bin/SpoonManager.exe をデバッグします。Debug には PDB を生成します。

[spoon.ps1](../spoon.ps1) はインストール済みの MSVC x64 と完全な Windows SDK を検出し、そのプロセスだけに環境変数を設定します。依存ソースと WebView2 SDK は固定バージョンと SHA-256 で検証します。ソースキャッシュは共有し、依存ライブラリのビルド先は構成ごとに分離します。

共有プリセットとコマンドの両方で Visual Studio 2026 の C++ Build Tools を使用します。コマンドはプリセットから Visual Studio の世代を読み取り、対応する MSVC x64 を検出します。以前のジェネレーターや存在しないインストール先を参照するキャッシュは、依存ソースと利用者データを保持して CMake の構成を作り直します。

build はアプリ、画面資産、NSIS Setup を作成して dist/spoon-manager/ に配置します。check はアプリだけをビルドし、launch は既存のアプリを起動します。clean はコンパイル成果物をクリーンし、取得済み依存や利用者データを保持します。画面資産は差分コピーし、削除した資産も同期します。

## テスト

CTest はモデル、通信、音声、アプリケーション、画面との接続、画面資産の同期、実際の WebView2 画面、インストーラーを検証します。ビルド後に VS Code のテストエクスプローラーまたはテストタスクから実行できます。コマンドからは .\spoon.ps1 test を使います。

--smoke --data-dir <隔離フォルダー> は専用のテストデータで画面を起動します。実際のアカウント、チャット送信、音声合成を使用しません。NSIS のテストは /TESTMODE で専用フォルダーに展開し、スタートメニューや本番の登録を変更せず、アンインストール後の未知ファイルと保存データの保持を確認します。

起動・UI テスト・インストールには導入済みの [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) が必要です。SDK の静的ローダーにブラウザー本体は含まれません。

## 音声出力

内蔵VOICEVOXはC APIを動的ロードしてCPU上で合成します。モデルは必要になった時点で読み込み、使用中モデルを最大2ファイルに制限します。合成は直列化し、停止したジョブは合成完了後でも再生しません。COREの同期合成中は推論自体を即時中断できないため、停止後に次の合成が始まるまで待つ場合があります。

取得・ライセンスは [prepare-voicevox.ps1](../scripts/prepare-voicevox.ps1)、[Voicevox.cmake](../cmake/Voicevox.cmake)、[モデル確認記録](../licenses/VOICEVOX-MODEL-REVIEW.md)を参照してください。内蔵音声のCTestは各モデルで実際にWAVを合成・デコードし、規約確認、除外話者、停止、話速を確認します。ネットワーク通信や音声再生は行いません。

Windows の既定出力または設定で指定した出力デバイスを使用します。VB-CABLE ならアプリの出力を CABLE Input、OBS の入力を CABLE Output に設定します。VoiceMeeter なら VoiceMeeter Input に出力し、対象ストリップの B1 を有効にしてください。仮想ドライバーは別途導入が必要です。

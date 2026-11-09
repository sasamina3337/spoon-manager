# チャット操作

設定で「チャット送信」と「コマンド応答」を有効にして保存し、DJの同意を取得してください。Spoonの配信チャットに次のコマンドを送ると応答します。画面から手動送信したコマンドには応答しません。

| 用途 | コマンド |
| --- | --- |
| 案内 | `/help`、`/help game`、`/help dj` |
| 記録 | `/stats`、`/me`、`/status total`、`/rank spoon`、`/rank heart`、`/rank comment` |
| 目標 | `/goal`、DJのみ `/goal heart 1000`、`/goal spoon 500` |
| 声 | `/voice`、`/voice list`、`/voice 8` |
| 質問 | `/質問 内容`、`/リクエスト 内容`、`/受付`、DJのみ `/受付 開始`・`/受付 停止` |
| 投票 | `/vote 1`、`/poll`、DJのみ `/poll 質問 \| 選択肢1 \| 選択肢2`・`/poll end` |
| 抽選 | DJのみ `/draw 1`〜`/draw 5` |
| 遊び | `/dice 2d6`、`/omikuji`、`/janken グー`、`/guess start`・`/guess 10`・`/guess end`、`/game` |
| 盤上ゲーム | `/reversi start`・`/reversi 3四`・`/reversi end`、`/shogi start`・`/shogi 7七 7六`・`/shogi end` |
| 天気 | `/天気 東京 明日`、`/weather Tokyo tomorrow`（Open-Meteo / GeoNames） |
| 参加URL | `/play shogi`、`/play reversi`、`/質問箱`、`/参加 確認コード` |

質問の受付と投票の集計は、返信の連投制限とは独立しています。ボット返信は通常3秒以上空け、同じ人のコマンドには設定した待ち時間を適用します。将棋盤は上下2通に分けます。API送信が失敗したコメントを自動再送することはありません。

読み上げ、質問の対応状況、公開URL、投票開始などの操作は画面からも行えます。詳細は[機能一覧](FEATURES.md)を参照してください。

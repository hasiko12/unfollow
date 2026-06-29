# X フォロー解除スクリプト

## セットアップ
node.jsをインストールしてください。その後、コマンドプロンプトやpowershellなどのCLIで、初回のみ


npm init -y
npm install playwright
npx playwright install chromium


## 設定

`unfollow.js` の CONFIG を編集:

| 設定項目 | 説明 | デフォルト |
|----------|------|-----------|
| `YOUR_USERNAME` | あなたの X ユーザー名（@不要） | 要変更 |
| `UNFOLLOW_LIMIT` | 1回の実行で解除する上限 | 100-200 |
| `DELAY_BETWEEN_UNFOLLOW` | 解除間隔 (ms) | 2500 |
| `DELAY_AFTER_BATCH` | バッチ後の休憩 (ms) | 20000 |
| `BATCH_SIZE` | 何件ごとに休憩するか | 30 |

## 残したいユーザーの指定

`keep_following.txt` にユーザー名を1行ずつ記載（@不要）


```
anthropic
someuser
```
## フォロー解除おすすめ設定 ##
今の unfollow.js では通常設定はこれです。

KEYWORD_ONLY_MODE: true
UNFOLLOW_MUTUAL: true
なので、現状は「キーワード一致した人を、相互でも解除する」設定です。unfollow.js

「自分をフォローしてくれていない人だけを通常解除」にしたいなら、少なくとも次に変えます。

KEYWORD_ONLY_MODE: false,
UNFOLLOW_MUTUAL: false,
これで挙動は「全員を対象に見るが、相互フォローはスキップ。つまり片想いだけ解除」です。

## 実行

node unfollow.js


C:\unfollow 等のフォルダにに新しい unfollow.js を配置
node unfollow.js を実行
Chromeが自動的に開く
初回のみ：ブラウザ上でXにログイン → ターミナル(CLI)でEnter
解除が始まる

初回はブラウザが開くのでそこから X にログイン後、ターミナルで Enter を押してください。  
2回目以降はログイン状態が保持されます。

## ログ

解除したユーザーは `unfollow_log.csv` に記録されます:

```csv
timestamp,username,display_name,profile_url
2025-03-28T10:00:00Z,someuser,Some User,https://x.com/someuser
```

- スクリプトを再実行してもログ済みのユーザーはスキップされます
- 再フォローしたい場合はこのログを参照してください

## 注意事項

- `DELAY_BETWEEN_UNFOLLOW` を 2000ms 未満にすると凍結リスクが上がります
- 1日あたり 200〜400 件程度を目安に分けて実行することを推奨します
- 数千人を全解除するには数日に分けることをおすすめします

chrome.runtime.onInstalled.addListener(details => {
    if (details.reason == 'install') {
        chrome.tabs.create({url: chrome.runtime.getURL("options.html")});
    }
});

chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
});

const ACTION_TITLE = 'B2クラウド自動再ログイン';

// セッションの維持は、ここが受け持つ。
//
// 以前はページ側のタイマーで回していたが、バックグラウンドのタブは Chrome や
// Edge に凍結され、タイマーも fetch も止まる。実測で65分の空白を踏み、60分の
// セッションが切れた。ページ側で猶予を広げても、セッションより長い空白は
// 埋めようがない。凍結と無関係に動くここへ移した。
//
// ページ側にも維持の仕組みは残してあるが、そちらは予備。詳細は contentScript.js
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_URL = 'https://newb2web.kuronekoyamato.co.jp/b2/p/_system_date';
const B2_PAGES = 'https://newb2web.kuronekoyamato.co.jp/*';
// 60分のセッションに対して十分短く取る。アラームが1〜2回遅れても間に合う
const KEEPALIVE_PERIOD_MINUTES = 20;
const KEEPALIVE_TIMEOUT = 30 * 1000;

// 残す件数。アラーム（20分おき）とページ側の報告（5分おき）が混ざるので、
// これで8時間ぶんほど見える
const KEEPALIVE_HISTORY = 100;

async function log(text) {
    const values = await chrome.storage.local.get(['debug', 'log']);

    if (values.debug !== true) {
        return;
    }

    const line = new Date().toLocaleTimeString('ja-JP') + ' ' + text;

    console.log('[B2] ' + line);

    // サービスワーカーは用が済むと終了し、コンソールの内容も消える。
    // 開発者ツールを繋いだままにすれば終了しなくなるが、それでは
    // 「終了したワーカーがアラームで起きるか」という肝心の点を試せない。
    // あとから読み返せるよう、結果だけ残す
    const history = values.log || [];

    history.push(line);
    chrome.storage.local.set({log: history.slice(-KEEPALIVE_HISTORY)});
}

async function keepSessionAlive() {
    // B2クラウドのタブが1つも無ければ、維持する理由が無い。開いてもいないのに
    // 裏で生かし続けるのは、共用PCでは使わないという注意書きと噛み合わない。
    //
    // タブの照会に tabs 権限は要らない。対象ホストの host_permissions があれば、
    // そのホストのタブは URL で絞り込める
    const tabs = await chrome.tabs.query({url: B2_PAGES});

    if (tabs.length === 0) {
        chrome.alarms.clear(KEEPALIVE_ALARM);
        log('停止（B2クラウドのタブなし）');
        return;
    }

    try {
        const response = await fetch(KEEPALIVE_URL, {
            cache: 'no-store',
            credentials: 'include',
            signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT)
        });

        // 失効していても止めない。別のタブでログインし直されれば、次の発火で
        // そのまま維持に戻れる
        if (response.status === 401) {
            log('失効');
        } else if (response.ok) {
            log('延長');
        } else {
            log('エラー' + response.status);
        }
        chrome.action.setTitle({
            title: ACTION_TITLE + '\n' + new Date().toLocaleTimeString('ja-JP') + ' 維持'
        });
    } catch (e) {
        log('通信失敗');
    }
}

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === KEEPALIVE_ALARM) {
        keepSessionAlive();
    }
});

// B2クラウドのページが読み込まれたら、アラームを張る。
// 既にあるものは張り直さない。create は同じ名前のアラームを置き換えるので、
// ページを開くたびに呼ぶと予定が毎回先送りされ、いつまでも発火しなくなる
async function ensureAlarm() {
    const existing = await chrome.alarms.get(KEEPALIVE_ALARM);

    if (!existing) {
        chrome.alarms.create(KEEPALIVE_ALARM, {periodInMinutes: KEEPALIVE_PERIOD_MINUTES});
        log('開始（' + KEEPALIVE_PERIOD_MINUTES + '分おき）');
    }
}

// デバッグ表示が有効なときだけ、セッションの残り時間をバッジに出す。
// B2クラウドのタブを裏に回しても見えるよう、タブ単位ではなく全体に表示する
async function updateBadge(message, tabId) {
    const values = await chrome.storage.local.get(['debug']);

    // 設定を切り替えたあとも古いコンテンツスクリプトは報告を続けるので、
    // 表示するかどうかはここで判断する
    if (values.debug !== true) {
        chrome.action.setBadgeText({text: ''});
        chrome.action.setTitle({title: ACTION_TITLE});
        return;
    }

    // ページ側の報告も同じ記録に混ぜる。タブが凍ったかどうかは、ページ側の
    // 空白とアラームの発火を同じ時間軸で見比べるのが一番早い。
    // ページのコンソールは画面遷移で消えてしまい、後から確かめられない
    log('ページ ' + message.state + (message.minutes === null ? '' : ' 残り' + message.minutes + '分'));

    // 残り時間が不明なだけの状態と、失効・失敗とを区別する。
    // 診断のための表示なので、まとめてしまうと役に立たない
    const unknown = message.minutes === null;
    const normal = message.state === '確認' || message.state === '延長' || message.state === '復帰';
    let color = '#008000';

    if (message.state === '失効') {
        color = '#cc0000';
    } else if (!normal) {
        color = '#cc6600';
    } else if (unknown) {
        color = '#808080';
    }

    chrome.action.setBadgeText({
        text: message.state === '失効' ? '!' : (unknown ? '?' : String(message.minutes))
    });
    chrome.action.setBadgeBackgroundColor({color: color});
    // タブが凍結されると報告が止まり、バッジは古い値のまま残る。数字だけでは
    // 「いまの残り時間」と「凍る直前の残り時間」を見分けられないので、
    // いつの値なのかを添える
    chrome.action.setTitle({
        title: ACTION_TITLE + '\n' + new Date().toLocaleTimeString('ja-JP') + ' ' + message.state
    });
    // サービスワーカーは短命なので、表示中のタブは storage に覚えておく。
    //
    // ここで待っているあいだにタブが閉じられると、消したはずの表示を書き戻して
    // しまう競合がある。塞ぐにはタブの生死を問い合わせる必要があり、tabs 権限が
    // 要る。診断用の表示のために権限を増やすほどの実害ではないので、そのままにする。
    // 残っても次の報告で上書きされる
    chrome.storage.session.set({badgeTabId: tabId});
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (!sender.tab) {
        return;
    }

    if (message.type === 'b2page') {
        ensureAlarm();
        return;
    }
    if (message.type === 'keepalive') {
        updateBadge(message, sender.tab.id);
    }
});

// デバッグ表示を無効にしたら、その場で消す
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.debug || changes.debug.newValue === true) {
        return;
    }

    chrome.action.setBadgeText({text: ''});
    chrome.action.setTitle({title: ACTION_TITLE});
    chrome.storage.session.remove('badgeTabId');
    // 診断のために溜めたものなので、表示をやめたら残さない
    chrome.storage.local.remove('log');
});

// 表示元のタブが閉じられたら、古い残り時間を消す
chrome.tabs.onRemoved.addListener(async tabId => {
    const values = await chrome.storage.session.get(['badgeTabId']);

    if (values.badgeTabId === tabId) {
        chrome.action.setBadgeText({text: ''});
        chrome.action.setTitle({title: ACTION_TITLE});
        chrome.storage.session.remove('badgeTabId');
    }
});

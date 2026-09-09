// 0.2.0 以前は、拡張を入れていても60分放置すればログアウトしていた。
// 0.3.0 からは切れない。席を外してもログインしたままになるので、共用PCで
// 使っている人には不利益になりうる。黙って挙動だけ変えず、一度だけ知らせる
function isBefore(version, target) {
    const a = String(version || '0').split('.').map(Number);
    const b = target.split('.').map(Number);

    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;

        if (x !== y) {
            return x < y;
        }
    }
    return false;
}

chrome.runtime.onInstalled.addListener(details => {
    if (details.reason == 'install') {
        chrome.tabs.create({url: chrome.runtime.getURL("options.html")});
        return;
    }

    if (details.reason == 'update' && isBefore(details.previousVersion, '0.3.0')) {
        chrome.tabs.create({url: chrome.runtime.getURL("options.html?updated=1")});
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

// 記録の書き込みは、アラームと複数のタブからの報告が同時に来る。読んで足して
// 書き戻す形なので、そのままでは後から終わったほうが先の追記を消す。
// 診断したい場面ほど取りこぼすので、順番に流す
let log_queue = Promise.resolve();

async function appendLog(text) {
    const values = await chrome.storage.local.get(['debug', 'log']);

    if (values.debug !== true) {
        return;
    }

    const line = new Date().toLocaleTimeString('ja-JP') + ' ' + text;
    const history = values.log || [];

    console.log('[B2] ' + line);
    history.push(line);
    // サービスワーカーは用が済むと終了し、コンソールの内容も消える。
    // 開発者ツールを繋いだままにすれば終了しなくなるが、それでは
    // 「終了したワーカーがアラームで起きるか」という肝心の点を試せない。
    // あとから読み返せるよう、結果を残す
    await chrome.storage.local.set({log: history.slice(-KEEPALIVE_HISTORY)});
    // 直近の出来事をツールチップにも出す。バッジの数字が凍ったタブの古い値の
    // ままでも、いつ何が起きたかはここで分かる
    chrome.action.setTitle({title: ACTION_TITLE + '\n' + line});
}

function log(text) {
    log_queue = log_queue.then(() => appendLog(text)).catch(() => {});
    return log_queue;
}

function clearLog() {
    // 削除も同じ列に並べる。処理中の追記が削除のあとに書き戻すと、
    // 消したはずの記録が復活し、以降は更新されないまま残り続ける
    log_queue = log_queue.then(() => chrome.storage.local.remove('log')).catch(() => {});
    return log_queue;
}

// アラームの張り替えは、設定の変更・ページの読み込み・発火の3か所から来る。
// どれも「読んでから書く」ので、あいだに別の経路が割り込むと、消したはずの
// アラームが残ったり、張ったはずのアラームが消えたりする。順番に流す
let alarm_queue = Promise.resolve();

function queueAlarm(fn) {
    alarm_queue = alarm_queue.then(fn).catch(() => {});
    return alarm_queue;
}

// 維持そのものを止められるようにしてある。0.2.0 以前と同じ、
// 無操作で60分後にログアウトする動きに戻したい人のため
async function keepAliveEnabled() {
    try {
        const values = await chrome.storage.local.get(['keepAlive']);

        return values.keepAlive !== false;
    } catch (e) {
        // 読めないまま黙って止まるより、維持する側に倒す
        return true;
    }
}

async function keepSessionAlive() {
    try {
        if (!await keepAliveEnabled()) {
            await queueAlarm(() => stopAlarm('維持が無効'));
            return;
        }

        // B2クラウドのタブが1つも無ければ、維持する理由が無い。開いてもいないのに
        // 裏で生かし続けるのは、共用PCでは使わないという注意書きと噛み合わない。
        //
        // タブの照会に tabs 権限は要らない。対象ホストの host_permissions があれば、
        // そのホストのタブは URL で絞り込める
        const tabs = await chrome.tabs.query({url: B2_PAGES});

        if (tabs.length === 0) {
            await queueAlarm(() => stopAlarm('B2クラウドのタブなし'));

            // 消すと決めてから消し終えるまでの間に開かれたタブを取りこぼさない。
            // ページ側からの通知は読み込み時の一度きりなので、ここで見落とすと
            // タブがあるのにアラームが無い状態が、次の画面遷移まで続く
            const opened = await chrome.tabs.query({url: B2_PAGES});

            if (opened.length > 0) {
                await queueAlarm(ensureAlarm);
            }
            return;
        }

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
    } catch (e) {
        // 通信だけでなく、タブの照会の失敗もここに来る。黙って終わると
        // 記録に何も残らないまま20分おきに失敗し続け、気づく手がかりが無くなる
        log('失敗（' + e.name + '）');
    }
}

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === KEEPALIVE_ALARM) {
        keepSessionAlive();
    }
});

async function stopAlarm(reason) {
    await chrome.alarms.clear(KEEPALIVE_ALARM);
    log('停止（' + reason + '）');
}

// B2クラウドのページが読み込まれたら、アラームを張る。
// 張れたら true を返す。張った直後に延長するかは呼び出し側が決める。
// ここで延長まで済ませてしまうと、列の中で keepSessionAlive を待つことになり、
// その keepSessionAlive がまた列を使うので噛み合わなくなる
async function ensureAlarm() {
    try {
        if (!await keepAliveEnabled()) {
            return false;
        }

        // 既にあるものは張り直さない。create は同じ名前のアラームを置き換えるので、
        // ページを開くたびに呼ぶと予定が毎回先送りされ、いつまでも発火しなくなる
        const existing = await chrome.alarms.get(KEEPALIVE_ALARM);

        if (existing) {
            return false;
        }

        await chrome.alarms.create(KEEPALIVE_ALARM, {periodInMinutes: KEEPALIVE_PERIOD_MINUTES});
        log('開始（' + KEEPALIVE_PERIOD_MINUTES + '分おき）');
        return true;
    } catch (e) {
        // 張れないまま黙って終わると、維持が始まっていないことに気づけない。
        // ページ側は表示に戻るたびに通知してくるので、次の機会に張り直せる
        log('アラームを張れず（' + e.name + '）');
        return false;
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
        queueAlarm(ensureAlarm);
        return;
    }
    if (message.type === 'keepalive') {
        updateBadge(message, sender.tab.id);
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
        return;
    }

    // 維持の切り替えは、次のページ読み込みを待たずにその場で効かせる
    if (changes.keepAlive) {
        if (changes.keepAlive.newValue === false) {
            queueAlarm(() => stopAlarm('維持が無効'));
        } else {
            // 最初の発火は20分後。無効にしていた間にセッションの残りが尽きて
            // いることがあるので、張れた場合だけ1回延長しておく
            queueAlarm(ensureAlarm).then(created => {
                if (created) {
                    keepSessionAlive();
                }
            });
        }
    }

    // デバッグ表示を無効にしたら、その場で消す
    if (changes.debug && changes.debug.newValue !== true) {
        chrome.action.setBadgeText({text: ''});
        chrome.action.setTitle({title: ACTION_TITLE});
        chrome.storage.session.remove('badgeTabId');
        // 診断のために溜めたものなので、表示をやめたら残さない
        clearLog();
    }
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

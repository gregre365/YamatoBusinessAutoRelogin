chrome.runtime.onInstalled.addListener(details => {
    if (details.reason == 'install') {
        chrome.tabs.create({url: chrome.runtime.getURL("options.html")});
    }
});

chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
});

const ACTION_TITLE = 'B2クラウド自動再ログイン';

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
    if (message.type !== 'keepalive' || !sender.tab) {
        return;
    }

    updateBadge(message, sender.tab.id);
});

// デバッグ表示を無効にしたら、その場で消す
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.debug || changes.debug.newValue === true) {
        return;
    }

    chrome.action.setBadgeText({text: ''});
    chrome.action.setTitle({title: ACTION_TITLE});
    chrome.storage.session.remove('badgeTabId');
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

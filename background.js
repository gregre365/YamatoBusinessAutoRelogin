chrome.runtime.onInstalled.addListener(details => {
    if (details.reason == 'install') {
        chrome.tabs.create({url: chrome.runtime.getURL("options.html")});
    }
});

chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
});

// デバッグ表示が有効なときだけ、セッションの残り時間をバッジに出す。
// B2クラウドのタブを裏に回しても見えるよう、タブ単位ではなく全体に表示する
async function updateBadge(message, tabId) {
    const values = await chrome.storage.local.get(['debug']);

    // 設定を切り替えたあとも古いコンテンツスクリプトは報告を続けるので、
    // 表示するかどうかはここで判断する
    if (values.debug !== true) {
        chrome.action.setBadgeText({text: ''});
        return;
    }

    // 残り時間が不明なだけの状態と、失効・失敗とを区別する。
    // 診断のための表示なので、まとめてしまうと役に立たない
    const unknown = message.minutes === null;
    const normal = message.state === '確認' || message.state === '延長';
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
    // サービスワーカーは短命なので、表示中のタブは storage に覚えておく
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
    chrome.storage.session.remove('badgeTabId');
});

// 表示元のタブが閉じられたら、古い残り時間を消す
chrome.tabs.onRemoved.addListener(async tabId => {
    const values = await chrome.storage.session.get(['badgeTabId']);

    if (values.badgeTabId === tabId) {
        chrome.action.setBadgeText({text: ''});
        chrome.storage.session.remove('badgeTabId');
    }
});

// B2クラウドのセッションは、最後の通信から60分で失効する。
// 残り時間は UID クッキーの有効期限に現れるので、失効が近いときだけ
// 読み取り専用の問い合わせを1回投げて延長する。画面には影響しない。
const KEEPALIVE_URL = '/b2/p/_system_date';
const KEEPALIVE_CHECK_INTERVAL = 5 * 60 * 1000;
// 確認の間隔より十分大きく取る。バックグラウンドのタブではタイマーが遅れるため
const KEEPALIVE_MARGIN = 15 * 60 * 1000;
// 有効期限を読めない場合に、代わりに使う固定間隔
const KEEPALIVE_FALLBACK_INTERVAL = 30 * 60 * 1000;
// 応答が返らないまま実行中の状態が残らないよう、短めに打ち切る
const KEEPALIVE_TIMEOUT = 30 * 1000;
// 読み込み直後は UID がまだ更新されていないので、少し待ってから最初の確認をする
const KEEPALIVE_INITIAL_DELAY = 10 * 1000;

let keepalive_timer = null;
let keepalive_last = Date.now();
let keepalive_running = false;
let keepalive_stopped = false;
let keepalive_debug = false;

async function uidExpiry() {
    if (typeof cookieStore === 'undefined') {
        return null;
    }

    try {
        const uid = await cookieStore.get('UID');

        return uid && uid.expires ? uid.expires : null;
    } catch (e) {
        // 読み取りに失敗した場合も、期限が分からないものとして扱う
        return null;
    }
}

function needsRenewal(remaining) {
    // 有効期限を読めない場合は、失効の60分より十分短い固定間隔で延長する
    if (remaining === null) {
        return Date.now() - keepalive_last >= KEEPALIVE_FALLBACK_INTERVAL;
    }
    return remaining <= KEEPALIVE_MARGIN;
}

function report(state, remaining) {
    if (!keepalive_debug) {
        return;
    }

    const minutes = remaining === null ? null : Math.round(remaining / 60000);

    console.log('[B2] ' + new Date().toLocaleTimeString('ja-JP') + ' ' + state +
        (minutes === null ? ' 残り不明' : ' 残り' + minutes + '分') +
        (document.visibilityState === 'hidden' ? '（バックグラウンド）' : ''));

    // 拡張が更新・再読み込みされると、ページに残ったこのスクリプトは拡張と
    // 通信できなくなる。セッションの維持は fetch だけで続けられるので、
    // 通知の失敗は無視する
    try {
        chrome.runtime.sendMessage({type: 'keepalive', state: state, minutes: minutes}).catch(() => {});
    } catch (e) {
        // Extension context invalidated
    }
}

async function keepSessionAlive() {
    // 失効を確認したあとは、visibilitychange や初回タイマーからも呼ばせない
    if (keepalive_stopped) {
        return;
    }
    // タイマーと visibilitychange が重なっても、同時に叩かない
    if (keepalive_running) {
        return;
    }
    keepalive_running = true;

    try {
        const expires = await uidExpiry();
        const remaining = expires === null ? null : expires - Date.now();

        if (!needsRenewal(remaining)) {
            report('確認', remaining);
            return;
        }

        const response = await fetch(KEEPALIVE_URL, {
            cache: 'no-store',
            credentials: 'same-origin',
            signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT)
        });

        // 失効したセッションは 401 を返す。それ以外の失敗は一時的なものとして
        // 次回に持ち越す。403 などで止めてしまうと、有効なセッションでも
        // 一度の拒否で維持が終わってしまう
        if (response.status === 401) {
            keepalive_stopped = true;
            clearInterval(keepalive_timer);
            report('失効', null);
            return;
        }
        if (!response.ok) {
            report('エラー' + response.status, remaining);
            return;
        }

        // 応答が返っただけでは延長できたとは限らないので、期限が実際に
        // 進んだかを確かめる。読めない場合は応答を信じるほかない
        const renewed = await uidExpiry();

        if (renewed === null || renewed - Date.now() > KEEPALIVE_MARGIN) {
            keepalive_last = Date.now();
            report('延長', renewed === null ? null : renewed - Date.now());
        } else {
            report('延長できず', renewed - Date.now());
        }
    } catch (e) {
        // 通信できなかった場合は延長できていないので、次回に持ち越す
        report('通信失敗', null);
    } finally {
        keepalive_running = false;
    }
}

function startKeepAlive() {
    // タイマーとリスナーを先に登録する。デバッグ表示の設定は本質ではないので、
    // その読み取りに失敗しても、セッションの維持だけは動かす
    keepalive_timer = setInterval(keepSessionAlive, KEEPALIVE_CHECK_INTERVAL);
    setTimeout(keepSessionAlive, KEEPALIVE_INITIAL_DELAY);
    // バックグラウンドのタブではタイマーが間引かれたり止まったりする。
    // 表示に戻った時点で確認し直す
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            keepSessionAlive();
        }
    });

    try {
        chrome.storage.local.get(['debug'])
            .then(values => {
                keepalive_debug = values.debug === true;
            })
            .catch(() => {});
    } catch (e) {
        // Extension context invalidated
    }
}

async function login() {
    const values = await chrome.storage.local.get(['code1', 'code2', 'password', 'id', 'autoLogin']);

    // 設定が無い場合（0.2.0 以前からの更新）は、従来どおり自動ログインする
    if (values.autoLogin === false) {
        return;
    }

    const element_code1 = document.getElementById('code1');
    const element_code2 = document.getElementById('code2');
    const element_password = document.getElementById('password');
    const element_id = document.getElementById('kojin');
    const button_login = document.evaluate('//*[@class="nav-login-btn"]/a', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0);

    element_code1.value = values.code1 || '';
    element_code2.value = values.code2 || '';
    element_password.type = 'password';
    element_password.value = values.password || '';
    element_id.value = values.id || '';

    if (element_code1.value != '' && element_password.value != '') {
        button_login.click();
    }
}

if (location.hostname === 'newb2web.kuronekoyamato.co.jp') {
    if (location.href === 'https://newb2web.kuronekoyamato.co.jp/system_error.html?api=0') {
        const button_login = document.getElementById('login');
        button_login.click();
    } else if (location.pathname !== '/system_error.html' && location.pathname !== '/sys_err.html') {
        startKeepAlive();
    }
} else if (location.href.indexOf('https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/logout_systemError.htm') == 0 ||
            location.href.indexOf('https://bmypage.kuronekoyamato.co.jp/bmypage/logout_systemError.htm') == 0) {
    const button_login = document.getElementById('submitButton');
    button_login.click();
} else if (location.href === 'https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/jp.co.kuronekoyamato.wur.hmp.servlet.user.HMPLGI0010JspServlet') {
    login();
} else if (location.href.indexOf('https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/jp.co.kuronekoyamato.wur.hmp.servlet.user.') == 0) {
    const button_login = document.evaluate('//*[@id="main"]/p/a[contains(text(), "ログイン画面へ")]', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (button_login.snapshotLength > 0) {
        button_login.snapshotItem(0).click();
    }
}

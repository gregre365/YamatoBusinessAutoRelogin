// B2クラウドのセッションは、最後の通信から60分で失効する。
// 残り時間は UID クッキーの有効期限に現れるので、失効が近いときだけ
// 読み取り専用の問い合わせを1回投げて延長する。画面には影響しない。
const KEEPALIVE_URL = '/b2/p/_system_date';
const KEEPALIVE_CHECK_INTERVAL = 5 * 60 * 1000;
// バックグラウンドのタブは凍結され、タイマーも fetch も止まる。解けたときに
// 残りがあるよう、早めに延長しておく。
//
// 耐えられる空白は、この猶予の長さちょうど。これより長く凍れば必ず切れる。
// 実測で 39.5分 の空白を踏んで切れたことがあるので、それを上回る値にしている。
// セッションの60分を超える猶予は取れないため、ここが上限に近い
const KEEPALIVE_MARGIN = 45 * 60 * 1000;
// 有効期限を読めない場合に、代わりに使う固定間隔。猶予と同じだけの空白に
// 耐えられるよう、60分からの引き算で合わせる
const KEEPALIVE_FALLBACK_INTERVAL = 15 * 60 * 1000;
// 応答が返らないまま実行中の状態が残らないよう、短めに打ち切る
const KEEPALIVE_TIMEOUT = 30 * 1000;
// 読み込み直後は UID がまだ更新されていないので、少し待ってから最初の確認をする
const KEEPALIVE_INITIAL_DELAY = 10 * 1000;
// 失効を確認したあとに問い合わせる間隔。別のタブでログインし直されることが
// あるので、諦めずに間隔を空けて確認を続ける
const KEEPALIVE_EXPIRED_INTERVAL = 10 * 60 * 1000;
// 打ち切りが効かず、実行中の印だけが残った場合に、それを捨てるまでの時間
const KEEPALIVE_STUCK = 3 * KEEPALIVE_TIMEOUT;

let keepalive_last = Date.now();
let keepalive_attempt = 0;
let keepalive_started = 0;
let keepalive_token = 0;
let keepalive_running = false;
let keepalive_expired = false;
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

function log(text) {
    if (!keepalive_debug) {
        return;
    }

    console.log('[B2] ' + new Date().toLocaleTimeString('ja-JP') + ' ' + text +
        (document.visibilityState === 'hidden' ? '（バックグラウンド）' : ''));
}

function report(state, remaining) {
    if (!keepalive_debug) {
        return;
    }

    const minutes = remaining === null ? null : Math.round(remaining / 60000);

    log(state + (minutes === null ? ' 残り不明' : ' 残り' + minutes + '分'));

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
    // タイマーと visibilitychange が重なっても、同時には叩かない。ただし
    // タブが凍結されるなどして、打ち切りも効かないまま実行中の印だけが残ると、
    // 以降のタイマーがすべて素通りして無言で止まる。時間を見て捨てる
    if (keepalive_running && Date.now() - keepalive_started < KEEPALIVE_STUCK) {
        return;
    }

    const token = ++keepalive_token;

    keepalive_running = true;
    keepalive_started = Date.now();

    try {
        const expires = await uidExpiry();

        // 捨てられた側の実行は、ここから先の状態に触らせない。触らせると、
        // 新しい実行が掴んだ失効や延長の結果を、古い結果で上書きしてしまう
        if (keepalive_token !== token) {
            return;
        }

        const remaining = expires === null ? null : expires - Date.now();

        // 失効後にクッキーが戻っていれば、別のタブでログインし直されている。
        // 問い合わせるまでもなく分かる
        if (keepalive_expired && remaining !== null && remaining > KEEPALIVE_MARGIN) {
            keepalive_expired = false;
            report('復帰', remaining);
            return;
        }
        // 失効したままなら、間隔を空けて様子を見る
        if (keepalive_expired && Date.now() - keepalive_attempt < KEEPALIVE_EXPIRED_INTERVAL) {
            return;
        }
        if (!keepalive_expired && !needsRenewal(remaining)) {
            report('確認', remaining);
            return;
        }

        keepalive_attempt = Date.now();

        const response = await fetch(KEEPALIVE_URL, {
            cache: 'no-store',
            credentials: 'same-origin',
            signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT)
        });

        // 応答を待つあいだに捨てられていることがある。ここでも確かめる
        if (keepalive_token !== token) {
            return;
        }

        // 失効したセッションは 401 を返す。それ以外の失敗は一時的なものとして
        // 次回に持ち越す。403 などで止めてしまうと、有効なセッションでも
        // 一度の拒否で維持が終わってしまう
        if (response.status === 401) {
            // 失効しても確認自体はやめない。やめてしまうと、自動ログインを
            // 無効にしている場合や、別のタブでログインし直された場合に、
            // このページはもう二度と維持に戻れない
            keepalive_expired = true;
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
        const left = renewed === null ? null : renewed - Date.now();

        if (left === null || left > KEEPALIVE_MARGIN) {
            keepalive_last = Date.now();
            report(keepalive_expired ? '復帰' : '延長', left);
            keepalive_expired = false;
        } else {
            report('延長できず', left);
        }
    } catch (e) {
        // 通信できなかった場合は延長できていないので、次回に持ち越す
        report('通信失敗', null);
    } finally {
        // 捨てたはずの古い実行が後から戻ってきても、いま動いている方の
        // 印は消さない
        if (keepalive_token === token) {
            keepalive_running = false;
        }
    }
}

function startKeepAlive() {
    // タイマーとリスナーを先に登録する。デバッグ表示の設定は本質ではないので、
    // その読み取りに失敗しても、セッションの維持だけは動かす
    setInterval(keepSessionAlive, KEEPALIVE_CHECK_INTERVAL);
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
                // 最初の確認まで10秒あり、その間は何も出ない。この1行が無いと
                // 「スクリプトが動いていない」と「まだ確認前」を見分けられない
                log('開始');
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

const BMYPAGE_LOGIN = 'https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/jp.co.kuronekoyamato.wur.hmp.servlet.user.HMPLGI0010JspServlet';
const BMYPAGE_USER = 'https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/jp.co.kuronekoyamato.wur.hmp.servlet.user.';
// B2クラウドのシステムエラー画面の「ログイン画面へ」が行く先。ポータルの
// ログイン画面ではなく、その手前のトップ
const B2_PORTAL_TOP = 'https://bmypage.kuronekoyamato.co.jp/bmypage/';
const BMYPAGE_RETURNED = 'b2_auto_relogin_returned';
const BMYPAGE_RETURN_INTERVAL = 60 * 1000;

// 復帰の行き先は、どの画面から始まっても最初から決まっている。
// 画面上のボタンやリンクを押す形にすると、id の変更や、javascript: 形式の
// リンクを阻む CSP のたびに動かなくなる。実際、押す作りにしていた3画面は
// すべて動かなくなっていた。押さずに、直接そこへ移動する
function returnToLogin(url) {
    // 同じ画面を往復し続けないよう、戻した時刻を覚えておく。判定は読み込み時の
    // 一度きりで、あとから再挑戦はしない。直前に戻ったばかりの画面では、
    // 自動復帰をあきらめて利用者に任せる。無限に往復するよりは、
    // エラー画面で止まって見えるほうがまだ良い。
    //
    // sessionStorage は、サイトのデータを禁じた設定などで例外を投げる。
    // 復帰を1か所にまとめたので、ここで投げるとポータル側の復帰が全経路まとめて
    // 黙って死ぬ。歯止めはあくまで保険なので、使えなければ無いものとして進む
    let returned = 0;

    try {
        returned = Number(sessionStorage.getItem(BMYPAGE_RETURNED) || 0);
    } catch (e) {
        // 前回の記録が読めない。歯止め無しで進む
    }

    if (Date.now() - returned <= BMYPAGE_RETURN_INTERVAL) {
        return;
    }

    try {
        sessionStorage.setItem(BMYPAGE_RETURNED, String(Date.now()));
    } catch (e) {
        // 記録できなくても移動はする。ログイン画面から戻された場合に往復しうるが、
        // 復帰できないまま止まるほうが困る
    }

    location.href = url;
}

if (location.hostname === 'newb2web.kuronekoyamato.co.jp') {
    if (location.pathname === '/system_error.html') {
        // ページ側は api=1 のときだけ「ログイン画面へ」を隠す。同じ条件にする
        if (new URLSearchParams(location.search).get('api') !== '1') {
            returnToLogin(B2_PORTAL_TOP);
        }
    } else if (location.pathname !== '/sys_err.html') {
        startKeepAlive();
    }
} else if (location.href.indexOf('https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/logout_systemError.htm') == 0 ||
            location.href.indexOf('https://bmypage.kuronekoyamato.co.jp/bmypage/logout_systemError.htm') == 0) {
    // 以前はこの画面の送信ボタン（id="submitButton"）を押していたが、
    // 押せなくなっていた。行き先は同じなので、押さずに移動する
    returnToLogin(BMYPAGE_LOGIN);
} else if (location.href === BMYPAGE_LOGIN) {
    login().catch(() => {
        // 設定を読めなければ入力しようがない。ログイン画面がそのまま残るだけで、
        // 手で入力すれば済む。未処理の拒否として残さないためだけの受け
    });
} else if (location.href.indexOf(BMYPAGE_USER) == 0 && location.href.indexOf(BMYPAGE_LOGIN) != 0) {
    // セッションが切れた画面から、ログイン画面まで戻す。
    // ログイン画面そのものは除く。ログイン直後の着地ページが、同じ URL に
    // クエリの付いた形でここに紛れ込む。戻すとログインをやり直すことになる。
    //
    // 画面の見分けは、この案内リンクの有無に頼っている。切れた画面だけを
    // 確実に指す URL や DOM が見つかっていないため。同じ案内を持つ正常な画面が
    // あれば、そこから勝手に飛ばしてしまう。実際、ログイン直後の着地ページが
    // これに当たっていた。下の往復制限は、その取りこぼしへの保険でもある
    const link_login = document.evaluate('//*[@id="main"]/p/a[contains(text(), "ログイン画面へ")]', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

    if (link_login.snapshotLength > 0) {
        returnToLogin(BMYPAGE_LOGIN);
    }
}

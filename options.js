
// 0.2.0 以前からの更新で開かれたときだけ、変わった点を知らせる。
// 機能が増えたからではなく、放置してもログアウトしなくなるという、
// 安全側の性質が変わったため
if (new URLSearchParams(location.search).get('updated') === '1') {
    document.getElementById('updated').hidden = false;
}

const element_autoLogin = document.getElementById('autoLogin');
const element_credentials = document.getElementById('credentials');
const element_debug = document.getElementById('debug');
const element_keepAlive = document.getElementById('keepAlive');

element_autoLogin.onchange = () => {
    element_credentials.disabled = !element_autoLogin.checked;
}

// ログイン情報の検証とは無関係な設定なので、保存ボタンに紐づけない。
// 紐づけると、ログイン情報を登録していない人がこのチェックだけ変えようとしたとき、
// 入力欄が空だという理由で弾かれて反映されない
function applyToggle(element, key, label) {
    // 素早く切り替えると保存が並走する。順番に流さないと、あとの操作の結果を
    // 先の操作が上書きしうる
    let queue = Promise.resolve();

    element.onchange = () => {
        const wanted = element.checked;

        queue = queue.then(async () => {
            try {
                await chrome.storage.local.set({[key]: wanted});
                element.dataset.saved = String(wanted);
                // 成功しても何も書かない。保存ボタンと同じ表示欄を使うので、
                // 書くとログイン情報の検証結果を消してしまう。チェックが
                // そのまま残っていることが、反映された印になる
            } catch (e) {
                // 戻す先は「いまの表示の反対」ではなく「最後に保存できた値」。
                // 反転させると、失敗したあとに利用者がもう一度切り替えていた場合、
                // その選択まで巻き戻して表示と保存値が食い違う
                if (element.checked === wanted) {
                    element.checked = element.dataset.saved === 'true';
                    document.getElementById('message').innerHTML = label + 'を変更できませんでした';
                }
            }
            updateWarning();
        });
    };
}

// 維持を無効にすれば、無操作でのログアウトは働く。警告文が実態と食い違わないようにする
function updateWarning() {
    document.getElementById('noLogout').hidden = !element_keepAlive.checked;
}

applyToggle(element_keepAlive, 'keepAlive', 'セッションの維持');
applyToggle(element_debug, 'debug', '状態の表示');

document.getElementById('save').onclick = async () => {
    const element_save = document.getElementById('save');
    const element_code1 = document.getElementById('code1');
    const element_code2 = document.getElementById('code2');
    const element_password = document.getElementById('password');
    const element_id = document.getElementById('id');
    const element_message = document.getElementById('message')
    let validate_ok = true;
    let message = '';

    // 前回の結果が残っていると、失敗したのに成功したように見える
    element_message.innerHTML = '';
    element_save.disabled = true;
    element_code1.setAttribute('style', '');
    element_code2.setAttribute('style', '');
    element_password.setAttribute('style', '');
    element_id.setAttribute('style', '');

    // 自動ログインが無効なら、保存済みのログイン情報を消す
    if (!element_autoLogin.checked) {
        try {
            await chrome.storage.local.set({
                autoLogin: false,
                code1: '',
                code2: '',
                password: '',
                id: ''
            });
        } catch (e) {
            element_message.innerHTML = '保存に失敗しました。ログイン情報は削除されていません';
            return;
        } finally {
            element_save.disabled = false;
        }
        element_code1.value = '';
        element_code2.value = '';
        element_password.value = '';
        element_id.value = '';
        element_message.innerHTML = '保存しました（ログイン情報を削除しました）';
        return;
    }

    // 長さだけを見ていると、全角の数字を入れても通ってしまう。日本語入力を
    // 使う画面では起こりやすく、「保存しました」と出たあと、次の自動ログインで
    // 初めて失敗が分かる
    if (!/^[0-9]{9,12}$/.test(element_code1.value)) {
        element_code1.setAttribute('style', 'background-color: yellow');
        validate_ok = false;
        message += '・お客様コードは半角数字9～12桁です<br>';
    }
    if (element_code2.value.length != 0 && !/^[0-9]{3}$/.test(element_code2.value)) {
        element_code2.setAttribute('style', 'background-color: yellow');
        validate_ok = false;
        message += '・お客様コード枝番は空白もしくは半角数字3桁です<br>';
    }
    // パスワードと個人ユーザーIDは長さだけを見る。ヤマト側が記号を許すかどうかを
    // 確認できていないため、文字種で弾くと、正しいパスワードを保存できなくなる
    if (element_password.value.length < 8 || element_password.value.length > 12) {
        element_password.setAttribute('style', 'background-color: yellow');
        validate_ok = false;
        message += '・パスワードは半角英数字8～12文字です<br>';
    }
    if (element_id.value.length != 0 && (element_id.value.length < 6 || element_id.value.length > 20)) {
        element_id.setAttribute('style', 'background-color: yellow');
        validate_ok = false;
        message += '・個人ユーザーIDは半角英数字6～20文字です<br>';
    }
    if (validate_ok) {
        try {
            await chrome.storage.local.set({
                autoLogin: true,
                code1: element_code1.value,
                code2: element_code2.value,
                password: element_password.value,
                id: element_id.value
            });
            message = '保存しました'
        } catch (e) {
            message = '保存に失敗しました。設定は変更されていません';
        }
    }
    element_save.disabled = false;
    element_message.innerHTML = message;
}

async function loadValues() {
    const values = await chrome.storage.local.get(['code1', 'code2', 'password', 'id', 'autoLogin', 'keepAlive', 'debug']);

    // Manifest V2 の頃に localStorage へ保存した設定を一度だけ引き継ぐ
    if (values.code1 === undefined && localStorage.code1) {
        const migrated = {
            code1: localStorage.code1 || '',
            code2: localStorage.code2 || '',
            password: localStorage.password || '',
            id: localStorage.id || ''
        };
        await chrome.storage.local.set(migrated);
        localStorage.clear();
        return migrated;
    }
    return values;
}

loadValues().then(values => {
    for (const key of ['code1', 'code2', 'password', 'id']) {
        if (values[key]) {
            document.getElementById(key).value = values[key];
        }
    }
    // 設定が無い場合（0.2.0 以前からの更新、または初回）は有効とする
    element_autoLogin.checked = values.autoLogin !== false;
    element_credentials.disabled = !element_autoLogin.checked;
    element_keepAlive.checked = values.keepAlive !== false;
    element_debug.checked = values.debug === true;
    // 読み込みが終わるまで触らせない。途中で切り替えると、直後の読み込みで
    // 表示だけ元に戻り、保存された値と食い違う
    // 保存に失敗したときに戻す先として、いま保存されている値を覚えておく
    element_keepAlive.dataset.saved = String(element_keepAlive.checked);
    element_debug.dataset.saved = String(element_debug.checked);
    element_keepAlive.disabled = false;
    element_debug.disabled = false;
    updateWarning();
    // 読み込みが終わるまで保存させない。途中で押されると、まだ反映されていない
    // チェックボックスの状態で保存され、ログイン情報を消してしまう
    document.getElementById('save').disabled = false;
}).catch(() => {
    // 読み込めなかった場合も、保存させてはいけない。空の入力欄のまま保存すると
    // 保存済みのログイン情報を消してしまう。無効のまま理由だけ伝える
    document.getElementById('message').innerHTML = '設定を読み込めませんでした。この画面を開き直してください';
});

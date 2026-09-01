
document.getElementById('save').onclick = async () => {
    const element_code1 = document.getElementById('code1');
    const element_code2 = document.getElementById('code2');
    const element_password = document.getElementById('password');
    const element_id = document.getElementById('id');
    const element_message = document.getElementById('message')
    let validate_ok = true;
    let message = '';

    element_code1.setAttribute('style', '');
    element_code2.setAttribute('style', '');
    element_password.setAttribute('style', '');
    element_id.setAttribute('style', '');

    if (element_code1.value.length < 9 || element_code1.value.length > 12) {
        element_code1.setAttribute('style', 'background-color: yellow');
        validate_ok = false;
        message += '・お客様コードは半角数字9～12桁です<br>';
    }
    if (element_code2.value.length != 0 && element_code2.value.length != 3) {
        element_code2.setAttribute('style', 'background-color: yellow');
        validate_ok = false;
        message += '・お客様コード枝番は空白もしくは半角数字3桁です<br>';
    }
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
        await chrome.storage.local.set({
            code1: element_code1.value,
            code2: element_code2.value,
            password: element_password.value,
            id: element_id.value
        });
        message = '保存しました'
    }
    element_message.innerHTML = message;
}

async function loadValues() {
    const values = await chrome.storage.local.get(['code1', 'code2', 'password', 'id']);

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
});

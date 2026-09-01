function getLocalValue(key) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage(key, response => {
            resolve(response);
        });
    });
}

async function login() {
    const element_code1 = document.getElementById('code1');
    const element_code2 = document.getElementById('code2');
    const element_password = document.getElementById('password');
    const element_id = document.getElementById('kojin');
    const button_login = document.evaluate('//*[@class="nav-login-btn"]/a', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotItem(0);

    element_code1.value = await getLocalValue('code1');
    element_code2.value = await getLocalValue('code2');
    element_password.type = 'password';
    element_password.value = await getLocalValue('password');
    element_id.value = await getLocalValue('id');

    if (element_code1.value != '' && element_password.value != '') {
        button_login.click();
    }
}

if (location.href === 'https://newb2web.kuronekoyamato.co.jp/system_error.html?api=0') {
    const button_login = document.getElementById('login');
    button_login.click();
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

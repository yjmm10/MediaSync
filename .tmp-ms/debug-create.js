(async () => {
  await new Promise((r) => setTimeout(r, 2000));
  const csrfMatch = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : '';
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (csrf) headers['X-CSRF-TOKEN'] = csrf;

  const login = await (await fetch('/api/v1/users/login/info', { credentials: 'include', headers })).json();
  let medal = null;
  try {
    medal = await (await fetch('/api/v1/medal/user/check', { credentials: 'include', headers })).json();
  } catch (e) {
    medal = { err: String(e) };
  }

  const uuid = () => 'ms' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const leaf = (t, marks) => [
    'span',
    { 'data-type': 'text' },
    ['span', Object.assign({ 'data-type': 'leaf' }, marks || {}), t],
  ];
  const empty = () => leaf('');
  const contentDraft = JSON.stringify([
    'root',
    {},
    ['h3', { uuid: uuid() }, leaf('MediaSync 调试草稿')],
    [
      'p',
      { uuid: uuid() },
      leaf('这是勋章开通后的自动调试。支持 '),
      leaf('加粗', { bold: true }),
      leaf(' 与 '),
      ['inlineCode', { uuid: uuid() }, leaf('code')],
      leaf('。'),
    ],
    [
      'code',
      { syntax: 'js', theme: 'default', code: 'console.log(1)', uuid: uuid() },
      empty(),
    ],
    [
      'code',
      {
        syntax: 'plaintext',
        theme: 'default',
        code: 'flowchart LR\n  A-->B',
        uuid: uuid(),
      },
      empty(),
    ],
  ]);

  const createRes = await fetch('/api/v1/articles', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ ContentDraft: contentDraft }),
  });
  const createText = await createRes.text();
  let createJson;
  try {
    createJson = JSON.parse(createText);
  } catch (e) {
    createJson = { raw: createText.slice(0, 500) };
  }

  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const up = await (
    await fetch('/api/v1/rm/uploadUrl', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ FileName: 't.png', Type: 'RACE_IMAGE' }),
    })
  ).json();

  let putStatus = null;
  let imgUrl = null;
  if (up && up.Data && up.Data.UploadUrl) {
    const put = await fetch(up.Data.UploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-oss-meta-author': 'aliy',
      },
      body: bin,
    });
    putStatus = put.status;
    const fileUrl = up.Data.UploadUrl.split('?')[0];
    const dl = await (
      await fetch('/api/v1/rm/downloadUrl', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ FileUrl: fileUrl, Type: 'RACE_IMAGE' }),
      })
    ).json();
    imgUrl = dl && dl.Data && dl.Data.DownloadUrl;
  }

  const id =
    createJson &&
    createJson.Data &&
    (createJson.Data.Id ||
      createJson.Data.id ||
      (createJson.Data.Articles &&
        createJson.Data.Articles[0] &&
        createJson.Data.Articles[0].Id));

  return {
    page: location.href,
    csrf: !!csrf,
    login: {
      Success: login.Success,
      Name: login.Data && login.Data.Name,
      Code: login.Code,
    },
    medal,
    create: {
      http: createRes.status,
      Code: createJson.Code,
      Success: createJson.Success,
      Message: createJson.Message,
      Id: id,
      DataKeys: createJson.Data ? Object.keys(createJson.Data) : null,
      raw: createJson.raw || null,
      DataSample: createJson.Data
        ? JSON.stringify(createJson.Data).slice(0, 400)
        : null,
    },
    editUrl: id ? 'https://modelscope.cn/learn/edit/' + id : null,
    image: { upCode: up && up.Code, putStatus, downloadUrl: imgUrl },
    ui: ((document.body && document.body.innerText) || '').slice(0, 180),
  };
})()

# 🚀 CoolPublisher – VS Code FTP Build Publisher

Univerzální rozšíření pro **Visual Studio Code**, které v jakémkoliv otevřeném repozitáři automaticky detekuje připravený build podle konfiguračního JSON souboru (`coolpublisher.json` nebo `publish-manifest.json`), zobrazí přehled v **levém Activity Baru** a jedním klikem nahraje celou adresářovou strukturu (např. **React Web + React Backoffice + PHP REST API**) na FTP (plně optimalizováno i pro free hosting **InfinityFree**).

---

## ✨ Hlavní funkce

1. **Ikona v levém panelu VS Code (Activity Bar)** s odznáčkem (`1`), jakmile je v repozitáři detekován hotový build připravený pro upload.
2. **Automatický hlídač (`FileSystemWatcher`)** – jakmile doběhne tvůj build skript a vygeneruje/aktualizuje `coolpublisher.json`, rozšíření se samo okamžitě přepne do stavu **PŘIPRAVENO PRO FTP UPLOAD** a nabídne nahrání.
3. **Podpora více modulů v jednom projektu**:
   - **Frontend – Web (React)** (`./frontend-web/dist` ➔ `/htdocs`)
   - **Frontend – Backoffice (React)** (`./frontend-backoffice/dist` ➔ `/htdocs/backoffice`)
   - **Backend – REST API (PHP)** (`./backend-api` ➔ `/htdocs/api`)
   - Každý modul lze v levém panelu samostatně zapnout/vypnout pomocí checkboxu.
4. **Bezpečná FTP autorizace** – FTP heslo se **nikdy neukládá do Gitu**, ale do nativního šifrovaného trezoru VS Code (`SecretStorage` / Windows Credential Manager).
5. **Optimalizováno pro InfinityFree (`ftpupload.net`)**:
   - Sekvenční přenos přes jedno FTP spojení (žádné blokování kvůli limitu paralelních spojení).
   - **Smart Sync (SHA-256)** – nahrává pouze změněné soubory, takže opakovaný publish trvá jen pár vteřin.
   - Automatické zakládání vnořených složek na FTP.

---

## 📦 Jak to používat v jakémkoliv tvém repozitáři

1. Otevři svůj projekt ve VS Code a klikni vlevo na ikonu **CoolPublisher** (obláček se šipkou).
2. Pokud v projektu ještě nemáš `coolpublisher.json`, klikni v panelu na **„✨ Inicializovat CoolPublisher v tomto repu“**.
3. Tím se v kořeni projektu vytvoří:
   - `coolpublisher.json` (definice složek buildu a cílových FTP cest)
   - `scripts/coolpublisher-build.mjs` (skript, který zkompiluje React části a označí JSON jako připravený k uploadu)

### Ukázka `coolpublisher.json`:

```json
{
  "projectName": "MujWeb-Portal",
  "version": "1.0.0",
  "builtAt": "2026-10-28T11:00:00.000Z",
  "readyForUpload": true,
  "buildCommand": "node scripts/coolpublisher-build.mjs",
  "ftp": {
    "host": "ftpupload.net",
    "port": 21,
    "user": "if0_37xxxxxx",
    "secure": true,
    "rejectUnauthorized": false
  },
  "mappings": [
    {
      "name": "Frontend - Web (React Build)",
      "type": "react-web",
      "localPath": "./frontend-web/dist",
      "remotePath": "/htdocs",
      "enabled": true,
      "exclude": ["*.map"]
    },
    {
      "name": "Frontend - Backoffice (React Build)",
      "type": "react-backoffice",
      "localPath": "./frontend-backoffice/dist",
      "remotePath": "/htdocs/backoffice",
      "enabled": true,
      "exclude": ["*.map"]
    },
    {
      "name": "Backend - REST API (PHP)",
      "type": "php-api",
      "localPath": "./backend-api",
      "remotePath": "/htdocs/api",
      "enabled": true,
      "exclude": [".env.local", ".git/**", "tests/**", "composer.lock"]
    }
  ]
}
```

---

## 🛠️ Vývoj, kompilace a instalace rozšíření do VS Code

Ve složce `C:\dev\Coolpublisher` spusť:

```bash
# 1. Instalace závislostí
npm install

# 2. Kompilace TypeScriptu do složky out/
npm run compile

# 3. Zabalení do instalačního balíčku .vsix
npm run package
```

Po vytvoření `coolpublisher-1.0.0.vsix` ho nainstaluješ do VS Code:
- V panelu **Extensions (`Ctrl+Shift+X`)** klikni nahoře na `...` ➔ **Install from VSIX...** a vyber `coolpublisher-1.0.0.vsix`, nebo v terminálu spusť:
  ```bash
  code --install-extension coolpublisher-1.0.0.vsix
  ```
- Nebo při otevřené složce `C:\dev\Coolpublisher` stiskni **`F5`** pro okamžité spuštění ve vývojovém okně VS Code.

# School Trailer Network Scraper — Render Ready

This version is ready for Render using the included `Dockerfile`.

## Deploy on Render

1. Upload/push this folder to GitHub.
2. Render → New → Web Service.
3. Connect the repo.
4. Environment: Docker.
5. Start command is already handled by the Dockerfile.
6. Deploy.

Render will use:

```txt
npm start
```

The app uses Render's `PORT` automatically.

## Local run

```powershell
npm install
npm run install-browser
npm start
```

Open:

```txt
http://localhost:3000
```

## Test the extractor

```powershell
npm run test-sample
```

# Fermi Notify Backend

API REST del servizio Fermi Notify, realizzata con Node.js ed Express. Gestisce autenticazione, profilo utente, keyword, preferenze di notifica e push subscription.

## Tecnologie

- Node.js 20 (ESM)
- Express
- PostgreSQL (via `pg`)
- JWT + refresh token (HttpOnly cookie)
- Azure Communication Services (email)
- Web Push (VAPID)

## Sviluppo con Docker

### Prerequisiti

- Docker + Docker Compose v2

Il compose del backend è il **punto di partenza** per l'intero stack di sviluppo: crea il DB, MailPit, Adminer e la rete Docker condivisa `ferminotify-dev`.

### Avvio

```bash
docker compose -f docker-compose.dev.yml up --build -d
```

Il backend è raggiungibile su `http://localhost:3001`.  
Avviare questo compose **prima** di frontend e notifier.

### Rebuild dopo modifiche al codice

```bash
docker compose -f docker-compose.dev.yml up --build -d
```

### Stop (mantiene i dati del DB)

```bash
docker compose -f docker-compose.dev.yml down
```

### Stop + reset completo del DB

```bash
docker compose -f docker-compose.dev.yml down -v
```

---

### Servizi inclusi

| Servizio | Porta host | Descrizione |
|----------|-----------|-------------|
| `backend` | `3001` | API REST |
| `db` | `5434` | PostgreSQL test (non usare la 5432 per non confliggere con un postgres locale) |
| `mailpit` | `1025` (SMTP) / `8025` (UI) | Catcher email — tutte le email inviate da backend e notifier finiscono qui |
| `adminer` | `8080` | UI web per il database (client PostgreSQL) |

### Credenziali DB di test

| Campo | Valore |
|-------|--------|
| Host | `localhost:5434` |
| Database | `fn-test-db` |
| User | `fn-test-user` |
| Password | `test` |

Connessione diretta (es. con psql o TablePlus):
```
postgresql://fn-test-user:test@localhost:5434/fn-test-db
```

Oppure via **Adminer** (UI web) su `http://localhost:8080`. Adminer gira dentro la rete Docker, quindi usa l'hostname interno:

| Campo | Valore |
|-------|--------|
| System | `PostgreSQL` |
| Server | `db` |
| User | `fn-test-user` |
| Password | `test` |
| Database | `fn-test-db` |

### Utente test precaricato

| Campo | Valore |
|-------|--------|
| Email | `test@example.com` |
| Password | `password` |


### Email

Il backend usa **Azure Communication Services** per inviare email (conferma registrazione, OTP reset password).

In sviluppo `AZURE_EMAIL_CONNECTION_STRING` è vuota → il backend usa il fallback **SMTP verso MailPit** (`SMTP_HOST=mailpit` nel compose): le email (conferma registrazione, OTP reset) vengono **catturate**, non inviate realmente.

Per inviare email **reali** via Azure (invece di catturarle) impostare una connection string nel compose:

```yaml
AZURE_EMAIL_CONNECTION_STRING: "endpoint=https://...;accesskey=..."
```

Tutte le email (backend + notifier) sono visibili nella UI MailPit su `http://localhost:8025`.

---

### Rete Docker

Il compose crea la rete `ferminotify-dev` (bridge). Frontend e notifier si agganciano a questa rete per raggiungere `db` e `mailpit` via hostname Docker interno.

---

### Variabili d'ambiente principali

| Variabile | Dev default | Descrizione |
|-----------|-------------|-------------|
| `DB_HOST` | `db` | Hostname postgres (interno Docker) |
| `DB_SSL_CERT` | *(non impostata)* | Se assente SSL è disabilitato — in produzione contiene il certificato CA |
| `JWT_SECRET` | `dev-jwt-secret-not-for-production` | Cambiare in produzione |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS origin consentita |
| `NOTIFICATION_API_KEY` | `dev-broadcast-key` | Chiave per `POST /user/push/notify/broadcast` |
| `AZURE_EMAIL_CONNECTION_STRING` | *(vuota)* | Lasciare vuota in dev (→ fallback MailPit) |
| `SMTP_HOST` | `mailpit` | Fallback SMTP dev: se Azure è vuoto, le email vanno qui |

---

## Avvio locale senza Docker

```bash
npm install
# creare un file .env con le variabili necessarie (vedi .env di esempio)
node server.js
```

## Endpoint principali

| Metodo | Path | Auth | Descrizione |
|--------|------|------|-------------|
| `PUT` | `/user/auth/register` | — | Registrazione |
| `POST` | `/user/auth/login` | — | Login, ritorna JWT + setta cookie refresh |
| `POST` | `/user/auth/refresh_token` | cookie | Rinnova access token |
| `POST` | `/user/auth/logout` | JWT | Logout, invalida refresh token |
| `POST` | `/user/auth/request-change-password` | — | Invia OTP reset password |
| `POST` | `/user/auth/otp-change-password` | — | Verifica OTP |
| `POST` | `/user/auth/new-change-password` | — | Imposta nuova password |
| `GET` | `/user/profile` | JWT | Profilo utente |
| `POST` | `/user/edit` | JWT | Modifica nome/cognome/genere |
| `PUT` | `/user/keyword/add` | JWT | Aggiunge keyword |
| `DELETE` | `/user/keyword/delete` | JWT | Rimuove keyword |
| `POST` | `/user/preferences/notification-preferences` | JWT | Cambia preferenze notifica |
| `POST` | `/user/push/subscribe` | JWT | Registra subscription push |
| `POST` | `/user/push/notify/broadcast` | API key | Invia push a tutti |

## Licenza

GNU AFFERO GENERAL PUBLIC LICENSE

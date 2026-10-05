# KOLIBRI — stappenplan naar live

**Voortgang bekijken:** dashboard → tab **Voortgang naar live**. Dat werkt ook als de desk nog niet
draait: `kolibri dashboard` (zelfde adres en toegangscode). Je ziet bovenaan het oordeel (op koers /
let op / niet op koers), daaronder het stappenplan, de opgetelde R per trade, het gemiddelde van de
laatste 20 trades tegenover de backtest, en per graduatie-check hoe ver je van de lat zit.

Elke fase heeft een **ga/stop-criterium**. Haal je dat niet, dan ga je niet door: dan is "niet
live gaan" de juiste uitkomst. `kolibri preflight` laat op elk moment zien waar je staat en wat de
volgende stap is. Reken op **6–10 weken** van nu tot live met normale ordergrootte.

Commando's staan als `kolibri …`. Met Docker: `docker compose run --rm kolibri kolibri …`.

---

## Fase 0 — Server klaarzetten (dag 0, ± 1 uur)

1. Huur een kleine Linux-VPS in de EU (2 vCPU / 4 GB is genoeg), Ubuntu 24.04.
2. Basis:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 git chrony
   sudo ufw allow OpenSSH && sudo ufw enable        # alleen SSH open; het dashboard gaat via een tunnel
   chronyc tracking                                  # klok moet synchroon lopen (afwijking < 100 ms)
   git clone https://github.com/rinvexz-hue/ponytail.git && cd ponytail/kolibri
   git checkout claude/kolibri-scalping-desk
   cp .env.example .env
   ```
3. Zet in `.env`: `DASHBOARD_TOKEN` (32 willekeurige tekens: `openssl rand -hex 16`).
4. Telegram: maak een bot via @BotFather → zet `TELEGRAM_BOT_TOKEN`; stuur je bot een bericht en
   haal je chat-id op via `https://api.telegram.org/bot<TOKEN>/getUpdates` → `TELEGRAM_CHAT_ID`.
5. Dashboard bekijken vanaf je laptop: `ssh -L 8080:127.0.0.1:8080 jij@vps` → open
   `http://127.0.0.1:8080`.

**Ga verder als:** `kolibri preflight` de punten onder "5. Live-voorbereiding" behalve de Kraken-sleutels groen toont.

---

## Fase 1 — Historische data (dag 0–1, enkele uren, loopt vanzelf)

```bash
kolibri download --days 120      # bouwt 1-minuut candles uit Kraken-trades; hervat waar hij stopte
```
Draai dit in `tmux`/`screen`, het duurt uren (Kraken beperkt het aantal verzoeken).

**Ga verder als:** preflight "minste historie ≥ 90 dagen" groen toont.

---

## Fase 2 — Backtest en optimalisatie (dag 1, ± 30 min)

```bash
kolibri backtest --days 120      # netto resultaat na fees, per setup en per munt
kolibri optimize --days 120      # robuuste zoektocht + winkans-kalibratie; leest data/optimize_report.md
```
- De optimizer houdt de laatste 25 % van de data apart (holdout), kiest op stabiliteit over 4
  tijdvakken, en adviseert alleen een wijziging als die ook op de holdout standhoudt.
- Advies "nieuwe parameters toepassen" → `kolibri optimize --days 120 --apply` (schrijft
  `config/local.yaml`). Advies "houden" → niets doen; dat is een prima uitkomst.
- Zet ook je **echte Kraken fee-niveau** in `config/local.yaml`:
  ```yaml
  venues:
    kraken: {maker_fee: "0.0022", taker_fee: "0.0038"}   # voorbeeld: niveau bij $10k volume of ~$20k tegoed
  ```

**Stop als:** de backtest na kosten een negatieve verwachting (expectancy) heeft of < 30 trades in
120 dagen. Dan levert live gaan op dit fee-niveau verwacht verlies op.

---

## Fase 3 — Paper trading (minimaal 2 weken, liefst 4)

```bash
docker compose up -d --build     # MODE=paper staat in .env
```
- Dagelijks: Telegram-dagrapport (00:00 UTC). Wekelijks: dashboard → "Waarom signalen werden
  afgewezen" (welke controle blokkeert het vaakst?) en de vermogenslijn.
- Wijzig in deze periode **niets** aan de instellingen (anders begint het bewijs opnieuw).

Na ≥ 14 dagen en ≥ 10 paper trades:
```bash
kolibri graduate --days 120      # leest automatisch het paper-journaal
```
**Ga verder als:** de uitkomst `CANARY ONLY` of `GRADUATED` is (`data/graduation_report.md`).
**Stop als:** `DO NOT GO LIVE`: kijk in het rapport welke checks falen.

---

## Fase 4 — Kraken voorbereiden (± 30 min)

1. Maak in Kraken Pro een **aparte subaccount** voor KOLIBRI. Zet er alleen EUR op: voor de canary
   ± €300–€500.
2. Maak een API-sleutel op die subaccount met **alleen**: *Query Funds*, *Query Open Orders &
   Trades*, *Query Closed Orders & Trades*, *Create & Modify Orders*, *Cancel/Close Orders*,
   *WebSocket interface*. **Nooit** *Withdraw Funds*. Zet de **IP-allowlist** op het IP van je VPS.
3. Zet `KRAKEN_API_KEY` en `KRAKEN_API_SECRET` in `.env`.
4. Controle (plaatst géén orders):
   ```bash
   kolibri check-live
   ```
   Dit toont je saldo en controleert prijsstap, lotgrootte, minimale ordergrootte en het fee-niveau
   dat Kraken jou echt rekent.

**Ga verder als:** check-live `OK` zegt. Wijkt het fee-niveau af, zet het goed in `config/local.yaml`,
draai `kolibri graduate` opnieuw (de config is veranderd) en dan check-live nog eens.

---

## Fase 5 — Canary: echt geld, minimale orders (1–3 weken)

In `.env`: `MODE=live` en `LIVE_CONFIRM=I_ACCEPT_THE_RISK`, dan `docker compose up -d`.
Met een `CANARY ONLY`-rapport begrenst KOLIBRI elke order op **€25** (`execution.canary_notional`).
Je test de echte uitvoering, niet de winst.

Controleer bij de **eerste 3 trades** in Kraken zelf:
- [ ] de instaporder was een limietorder (post-only) en werd gevuld;
- [ ] direct daarna staat er een **stop-loss order** bij Kraken;
- [ ] bij +1R wordt de helft verkocht en schuift de stop naar instap + kosten;
- [ ] de fees staan in EUR;
- [ ] dashboard en Kraken tonen dezelfde positie, en er komen geen noodstop-meldingen.

Oefen één keer bewust de noodprocedures (met een kleine open positie):
- [ ] **NOODSTOP** op het dashboard → alles gesloten, handel gestopt, Telegram-alarm. Daarna **Hervatten**.
- [ ] `docker compose restart` met een open positie → bij opstart wordt de positie gesloten en
      stopt de handel (bewust, fail-closed). Daarna `kolibri rearm` of de knop **Hervatten**.

Na ≥ 10 canary-trades zonder automatische noodstops:
```bash
kolibri graduate --days 120      # leest paper- én live-journaal
```
**Ga verder als:** `GRADUATED`. **Stop als:** automatische noodstops, of de canary-resultaten
zijn duidelijk slechter dan paper. Zoek eerst de oorzaak uit (slippage? fills? fees?).

---

## Fase 6 — Live-small: normale ordergrootte (≥ 4 weken)

Zet op de subaccount maximaal **10 %** van het kapitaal dat je uiteindelijk wilt inzetten. Daarna
geldt de normale grootte: 0,25 % risico per trade, max 1 % in totaal, 1x, alleen kopen. Start opnieuw.

Automatische beveiliging (je hoeft niets te doen):
- dagverlies −2 % → alles dicht, stop tot de volgende dag;
- weekverlies −5 % of −8 % vanaf de top → stop tot jij hervat.

**Stop zelf** (NOODSTOP en uitzoeken) bij:
- een noodstop die je niet kunt verklaren;
- 3 weken op rij verlies;
- drift-meldingen: live wijkt duidelijk af van de backtest.

---

## Fase 7 — Opschalen

Pas na ≥ 50 live trades die in lijn liggen met de backtest. Hoogstens verdubbelen per maand, en elke
maand opnieuw `kolibri graduate` (het rapport verloopt na 30 dagen).

---

## Altijd onthouden
- Elke wijziging aan de handelsinstellingen verandert de config-vingerafdruk. Live start daarna
  niet tot je opnieuw `kolibri graduate` draait.
- Paper en live hebben elk een eigen journaal: `data/kolibri-paper.sqlite` en `data/kolibri-live.sqlite`.
- Geen trade is ook een uitkomst: bij Kraken-fees verwacht je weinig trades.
- Dit systeem garandeert geen winst. Zet nooit geld in dat je niet kunt missen.

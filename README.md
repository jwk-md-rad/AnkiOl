# Woordjes

Een AnkiWeb-achtige app om woordjes en zinnen te overhoren (Engels ↔ Nederlands, ook Frans/Duits mogelijk), gemaakt voor de **Chromebook**.

- **Foto → kaartjes**: maak een foto van de woordenlijst in je leerboek (of kies een bestaande foto) en de app maakt de kaartjes. Daarna controleer en verbeter je ze voordat ze worden opgeslagen.
  - *Gratis tekstherkenning* (Tesseract OCR, in de browser): herkent kolommen zoals `the teacher    de leraar` of `house - huis`.
  - *Claude AI* (optioneel, met eigen Anthropic API-sleutel): beter in lastige layouts, voorbeeldzinnen, fonetisch schrift weglaten en EN/NL automatisch op de goede kant zetten.
- Woordjes per **hoofdstuk** (bijvoorbeeld *Engels H4*), zoals in het leerboek.
- **Stones** (zinsbouw-schema's uit Stepping Stones): foto uploaden → Claude verzint oefenzinnen (Nederlands → Engels vertalen, vraag beantwoorden, gatenzin) met steeds andere namen, datums en woorden. Antwoord op papier schrijven, omdraaien, zelf nakijken. Elke herhaling een andere variant. Vereist een Claude API-sleutel (schatting: ± 10–25 cent per Stone met Opus, ± 5–12 met Sonnet).
- **Spaced repetition** zoals Anki (SM-2): nieuwe woordjes komen terug na 1 en 10 minuten, daarna na 1 dag, en steeds langere tijd zolang je ze goed weet. Fout = vaker oefenen.
- **Per sessie kiezen**: *omdraaien en zelf beoordelen* (Opnieuw / Moeilijk / Goed / Makkelijk) of *antwoord intypen* (tolerant voor hoofdletters, accenten, lidwoorden en kleine typfouten).
- Richting kiezen: Engels → Nederlands, Nederlands → Engels of beide (elke richting heeft een eigen planning).
- *Alles oefenen* (toetsmodus): alle woordjes van een hoofdstuk langs, zonder de planning te verstoren.
- Voorlezen van Engelse woorden (spraak van Chrome).
- Werkt **offline** en kan geïnstalleerd worden als app. Gegevens staan lokaal op de Chromebook; met *Back-up downloaden* maak je een kopie (bv. in Google Drive).

## Sneltoetsen bij het overhoren

| Toets | Actie |
|---|---|
| Spatie / Enter | Antwoord tonen |
| 1 2 3 4 | Opnieuw / Moeilijk / Goed / Makkelijk |
| Enter (intypen) | Controleren, daarna de voorgestelde beoordeling |

## Op de Chromebook zetten

De app is een gewone website zonder server-onderdelen. Zet hem online met **GitHub Pages**:

1. GitHub → *Settings* → *Pages* → *Deploy from a branch* → kies de branch en map `/ (root)`.
2. Open de link (`https://<gebruiker>.github.io/<repo>/`) in Chrome op de Chromebook.
3. Klik op het installeer-icoon (⊕) rechts in de adresbalk → *Installeren*. De app staat nu in de launcher en werkt ook offline.

Lokaal uitproberen: `npm start` en open <http://localhost:8080>.

## Claude AI instellen (optioneel)

1. Maak een API-sleutel op <https://console.anthropic.com/settings/keys> en zet er wat tegoed op.
2. Open in de app ⚙ *Instellingen* en plak de sleutel.
3. Kies het model: **Claude Opus 5.5** (beste resultaat, ± 5–10 cent per bladzijde) of **Claude Sonnet 5.5** (goedkoper, ± 2–5 cent per bladzijde). Dit zijn schattingen; de echte kosten hangen af van de foto en het aantal woordjes.
4. Bij *Foto → kaartjes* staat nu Claude als keuze.

De sleutel wordt alleen lokaal in de browser bewaard en rechtstreeks naar de Anthropic API gestuurd. Deel het apparaat niet met mensen die de sleutel niet mogen gebruiken.
Als Claude een verzoek weigert, schakelt de API automatisch over op een ander model (de optie `fallbacks: "default"`).

## Ontwikkeling

Gewone HTML/CSS/JavaScript-modules, geen build-stap.

```
index.html, styles.css, sw.js, manifest.webmanifest
js/app.js      schermen en navigatie
js/srs.js      spaced-repetition-algoritme (SM-2, Anki-stijl)
js/session.js  volgorde van kaarten in een sessie
js/check.js    controle van ingetypte antwoorden
js/parse.js    tekst/OCR-regels → woordparen
js/ocr.js      Tesseract.js (gratis OCR)
js/claude.js   Claude API (foto → kaartjes)
js/db.js       IndexedDB-opslag, back-up
```

Tests: `npm test`

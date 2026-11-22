// Kaartjes maken van een foto met Claude (vereist een eigen Anthropic API-sleutel).
// De sleutel staat alleen lokaal op dit apparaat en gaat rechtstreeks naar Anthropic.

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk';
const LANG_NAMES = { en: 'Engels', nl: 'Nederlands', fr: 'Frans', de: 'Duits' };

// Per deel van de bladzijde (kopje) de kaartjes, in de volgorde van het boek.
// Zo volgt Claude de indeling kolom voor kolom in plaats van per woord te raden.
const SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string' },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                front: { type: 'string' },
                back: { type: 'string' },
                example: { type: 'string' },
              },
              required: ['front', 'back', 'example'],
              additionalProperties: false,
            },
          },
        },
        required: ['section', 'cards'],
        additionalProperties: false,
      },
    },
  },
  required: ['sections'],
  additionalProperties: false,
};

// Eén verzoek aan Claude met foto('s) en een antwoord in een vast JSON-formaat.
async function askClaude({ images, prompt, schema, apiKey, model, maxTokens = 16000 }) {
  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  // Streaming: lange antwoorden (veel oefeningen) lopen anders tegen de time-out aan.
  const stream = client.beta.messages.stream({
    model,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('Claude kon deze foto niet verwerken.');
  if (response.stop_reason === 'max_tokens') throw new Error('Te veel tekst in één keer; probeer minder foto’s tegelijk.');
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Geen antwoord van Claude ontvangen.');
  return JSON.parse(textBlock.text);
}

export async function claudePairs(base64Jpeg, apiKey, { frontLang = 'en', backLang = 'nl', model = 'claude-opus-5-5' } = {}) {
  const front = LANG_NAMES[frontLang] || frontLang;
  const back = LANG_NAMES[backLang] || backLang;

  const prompt = `Dit is een foto van een pagina uit een schoolboek met woordjes en/of zinnen om te leren (${front} en ${back}).
Maak er flashcards van:
- "front" is altijd de ${front} tekst, "back" de ${back} vertaling. Draai de volgorde om als het boek ze andersom geeft.
- Neem elk woord of elke zin over precies zoals in het boek staat, inclusief lidwoorden ("to" bij werkwoorden, "de/het" bij Nederlandse zelfstandige naamwoorden) als die erbij staan.
- Meerdere vertalingen voor één woord zet je samen in "back", gescheiden door komma's.
- Sla kopjes, paginanummers, uitspraaktekens (fonetisch schrift), oefeningen en uitleg over.
- Staat er een voorbeeldzin met vertaling bij, maak daar dan een aparte kaart van.
- Sommige bladzijdes hebben ${front} voorbeeldzinnen waarin het te leren woord (of de woordgroep) gekleurd is, bijvoorbeeld oranje, met rechts (achter een vakje) alleen de ${back} vertaling van dat woord. Maak dan per zin één kaart: "front" = alleen het gekleurde woord of de gekleurde woordgroep, precies zoals in de zin (staan de gekleurde woorden niet naast elkaar, zoals "be very lucky" met "be" en "lucky" gekleurd, zet dan alleen de gekleurde woorden achter elkaar: "be lucky"); "back" = de vertaling uit de rechterkolom; "example" = de hele voorbeeldzin, letterlijk overgenomen.
- Bij gewone woordjes zonder zo'n voorbeeldzin is "example" een lege string.
- Geef de kaarten per deel van de bladzijde ("sections"). Een deel begint bij een kopje, meestal een letter met een Engelse
  titel ("B Groceries", "D Flavours", "H At the restaurant", "A WATCHING"). "section" is die letter met de Engelse titel,
  met alleen een hoofdletter aan het begin: "B Groceries", "B In the kitchen", "D Flavours", "H At the restaurant", "A Watching".
  Werk zo: lees de bladzijde kolom voor kolom (eerst de linker kolom van boven naar beneden, dan de volgende kolom).
  Elk kopje begint een nieuw deel. Een deel loopt door tot het volgende kopje, ook over de rand van een kolom heen:
  woorden bovenaan een kolom zonder eigen kopje horen nog bij het laatste kopje van de kolom ervoor.
  Een woord dat ONDER een kopje staat, hoort altijd bij dat kopje en niet bij een eerder deel.
  Pijltjes of andere tekentjes bij een kopje horen niet bij de titel. Twee delen met dezelfde letter (bv. "B Groceries" en
  "B In the kitchen") zijn aparte delen. Staat er geen kopje met een letter, gebruik dan het kopje zelf; zonder kopje een lege string.
- De foto kan scheef of op z'n kant staan; lees hem in de juiste richting.
- Verzin niets wat niet op de foto staat. Is de foto onleesbaar, geef dan een lege lijst.`;

  const parsed = await askClaude({ images: [base64Jpeg], prompt, schema: SCHEMA, apiKey, model });
  return cardsFromSections(parsed);
}

// Antwoord van Claude (kaarten per deel) → één lijst kaartjes met hun deel.
export function cardsFromSections(parsed) {
  return (parsed.sections || [])
    .flatMap((s) =>
      (s.cards || []).map((c) => ({
        front: c.front.trim(),
        back: c.back.trim(),
        example: (c.example || '').trim(),
        section: (s.section || '').trim(),
        ok: true,
      }))
    )
    .filter((c) => c.front && c.back);
}

// ---------- Stones: zinsbouw-schema's → oefenzinnen ----------

const STONE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['translate', 'answer', 'gap'] },
          pattern: { type: 'string' },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                answer: { type: 'string' },
                alternatives: { type: 'array', items: { type: 'string' } },
              },
              required: ['prompt', 'answer', 'alternatives'],
              additionalProperties: false,
            },
          },
        },
        required: ['type', 'pattern', 'variants'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'exercises'],
  additionalProperties: false,
};

export const STONE_TYPES = {
  translate: 'Vertaal naar het Engels',
  answer: 'Beantwoord de vraag',
  gap: 'Vul het ontbrekende stuk in',
};

// Foto('s) van een "Stone" (schema met zinsdelen in vakjes) of een grammatica-overzicht
// (regels met voorbeeldzinnen) → oefeningen met varianten.
export async function claudeStone(base64Jpegs, apiKey, { model = 'claude-opus-5-5' } = {}) {
  const prompt = `Dit is een bladzijde uit het Engelse schoolboek Stepping Stones (brugklas, Nederlandse leerling van 12–13 jaar).
Het is een "Stone" of een grammatica-overzicht:
- Een Stone is een schema van zinsdelen in vakjes, verbonden met lijnen: elk pad door de vakjes vormt een zin (vraag of antwoord).
- Een grammatica-overzicht (bv. "Grammar", "Grammar Survey", tabellen met genummerde onderwerpen zoals "Some and any",
  "Plurals", "Future: going to", "This, that, these, those") geeft per onderwerp de regel met voorbeeldzinnen of voorbeeldwoorden.
  Behandel dan elk grammatica-onderwerp als een zinspatroon, en de regels en voorbeelden uit de tabel als de zinsbouw.
  Bij woordvormen (bv. meervouden) maak je "gap"-oefeningen met het grondwoord als hint, bv. "Two ___ (knife)." → "knives",
  met andere woorden dan in het boek die dezelfde regel volgen (en de onregelmatige woorden uit de tabel zelf, die moet
  de leerling uit zijn hoofd kennen). Bij een keuze (bv. some/any, this/that/these/those) zet je de keuzes als hint tussen
  haakjes, bv. "Are there ___ (some/any) apples?" → "any", of een Nederlandse hint als dat duidelijker is ("___ shoes (deze)").
  Gebruik bij "translate" zinnen die precies die grammatica oefenen.
De school zegt: "Leer de Stones net als de woordjes. Herhaal, varieer en schrijf op! Verander bijvoorbeeld de onderwerpen,
werkwoorden en andere vocabulaire. Leerlingen moeten de Stones ook kunnen toepassen in een lopende tekst."

Maak oefeningen waarmee de leerling de zinsbouw van deze Stone leert. De leerling schrijft zijn antwoord op papier en kijkt
daarna zelf na met jouw antwoord. Doe dit:
1. Lees alle zinnen die het schema maakt (alle paden door de vakjes), of alle onderwerpen en voorbeelden van het grammatica-overzicht.
   "title" is de titel, bv. "Stone 2 – Talking about personal information" of "Grammar Chapter 3 – some/any, plurals, going to, this/that".
2. Maak per zinspatroon oefeningen van deze soorten (niet elk patroon hoeft alle soorten):
   - "translate": "prompt" is een natuurlijke Nederlandse zin, "answer" de Engelse zin volgens het patroon.
   - "answer": "prompt" is een Engelse vraag uit de Stone, "answer" een voorbeeldantwoord in een volledige Engelse zin
     (over een verzonnen tiener), volgens het antwoordpatroon uit de Stone.
   - "gap": "prompt" is een Engelse zin met "___" op de plek van een belangrijk stuk uit de Stone (bv. het vraagwoord of
     het werkwoord), "answer" alleen de ontbrekende woorden. Zet er tussen haakjes een Nederlandse hint achter als het anders
     niet te raden is, bv. "___ is your birthday? (Wanneer)".
3. Geef elke oefening 4 tot 6 "variants" die het patroon steeds net anders gebruiken: andere namen, datums, leeftijden,
   plaatsen, landen, nationaliteiten, schoolvakken, werkwoorden en vocabulaire, zoals de school vraagt. Blijf bij de grammatica
   en het niveau van de Stone (A1–A2), Brits Engels zoals het boek.
   Belangrijk: GEEN enkele variant is letterlijk een zin uit het boek; de zinnen uit het boek zijn alleen het voorbeeld van de
   zinsbouw. Elke variant verandert minstens twee dingen ten opzichte van het boek en van de andere varianten. Gebruik ook andere
   personen waar de zinsbouw dat toelaat (he, she, my sister, they, Tom en Lisa), zodat de leerling de zinsbouw toepast in plaats
   van één zin uit zijn hoofd te leren.
4. "pattern" is het patroon in het Engels met het variabele deel tussen haakjes, bv. "When is your birthday? – My birthday is on the (17th) of (May)."
   Bij grammatica: de regel kort, met het onderwerp ervoor, bv. "Plurals: consonant + y → -ies (party → parties)" of
   "Some/any: some in + zinnen en in vragen waarop je 'ja' verwacht; any in – zinnen en gewone vragen".
5. "alternatives": andere goede antwoorden (bv. "I'm" naast "I am", "It's" naast "It is", andere woordvolgorde die ook klopt).
   Laat leeg als er geen zijn.
6. Maak in totaal 15 tot 30 oefeningen, verdeeld over alle onderwerpen. Verzin geen grammatica die niet op de foto staat.
De foto kan scheef of op z'n kant staan. Staat er geen Stone en geen grammatica op, of is hij onleesbaar, geef dan een lege lijst.`;

  const parsed = await askClaude({ images: base64Jpegs, prompt, schema: STONE_SCHEMA, apiKey, model, maxTokens: 32000 });
  const exercises = parsed.exercises
    .map((e) => ({
      type: e.type,
      pattern: e.pattern.trim(),
      variants: e.variants
        .map((v) => ({ prompt: v.prompt.trim(), answer: v.answer.trim(), alternatives: v.alternatives.map((a) => a.trim()).filter(Boolean) }))
        .filter((v) => v.prompt && v.answer),
      ok: true,
    }))
    .filter((e) => e.variants.length);
  return { title: parsed.title.trim(), exercises };
}

// ---------- Nieuwe varianten bijmaken (zonder foto) ----------

const MORE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          variants: STONE_SCHEMA.properties.exercises.items.properties.variants,
        },
        required: ['id', 'variants'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// Voor elke Stone-oefening een paar nieuwe varianten, anders dan de bestaande.
// exercises: [{ id, stone, type, pattern, variants }]. Geeft { id: [varianten] }.
export async function claudeMoreVariants(exercises, apiKey, { model = 'claude-opus-5-5', count = 4 } = {}) {
  const list = exercises.map((e) => ({
    id: e.id,
    stone: e.stone,
    soort: e.type,
    zinsbouw: e.pattern,
    al_gebruikt: e.variants.map((v) => `${v.prompt} → ${v.answer}`),
  }));
  const prompt = `Je maakt oefenzinnen voor een Nederlandse brugklasleerling (12–13 jaar) die de "Stones" en de grammatica uit het
Engelse schoolboek Stepping Stones leert: zinsbouw-schema's en grammaticaregels die je moet kunnen toepassen met steeds andere woorden. De school zegt: "Herhaal,
varieer en schrijf op! Verander de onderwerpen, werkwoorden en andere vocabulaire." De leerling schrijft het antwoord op
papier en kijkt zelf na.

Hieronder staan oefeningen (JSON). Maak voor elke oefening ${count} NIEUWE varianten van dezelfde soort en met dezelfde zinsbouw:
- "translate": "prompt" een natuurlijke Nederlandse zin, "answer" de Engelse zin volgens de zinsbouw.
- "answer": "prompt" een Engelse vraag volgens de zinsbouw, "answer" een voorbeeldantwoord in een volledige Engelse zin.
- "gap": "prompt" een Engelse zin met "___" op de plek van het belangrijke stuk uit de zinsbouw, "answer" alleen de
  ontbrekende woorden; zet er een Nederlandse hint tussen haakjes achter als het anders niet te raden is.
Regels:
- Elke nieuwe variant moet duidelijk anders zijn dan alles in "al_gebruikt" en dan de andere nieuwe varianten: verander
  minstens twee dingen (namen, personen, datums, getallen, plaatsen, landen, schoolvakken, werkwoorden, onderwerpen).
- Blijf bij de zinsbouw en het niveau (A1–A2), Brits Engels. Verzin geen nieuwe grammatica.
- "alternatives": andere goede antwoorden (bv. "I'm" naast "I am"), of leeg.
- Geef in "items" voor elke oefening het "id" terug, precies zoals het hieronder staat.

${JSON.stringify(list, null, 1)}`;

  const parsed = await askClaude({ images: [], prompt, schema: MORE_SCHEMA, apiKey, model, maxTokens: 16000 });
  const out = {};
  for (const item of parsed.items) {
    out[item.id] = item.variants
      .map((v) => ({ prompt: v.prompt.trim(), answer: v.answer.trim(), alternatives: v.alternatives.map((a) => a.trim()).filter(Boolean) }))
      .filter((v) => v.prompt && v.answer);
  }
  return out;
}

// Kaartjes maken van een foto met Claude (vereist een eigen Anthropic API-sleutel).
// De sleutel staat alleen lokaal op dit apparaat en gaat rechtstreeks naar Anthropic.

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk';
const LANG_NAMES = { en: 'Engels', nl: 'Nederlands', fr: 'Frans', de: 'Duits' };

const SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          front: { type: 'string' },
          back: { type: 'string' },
        },
        required: ['front', 'back'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
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
- De foto kan scheef of op z'n kant staan; lees hem in de juiste richting.
- Verzin niets wat niet op de foto staat. Is de foto onleesbaar, geef dan een lege lijst.`;

  const parsed = await askClaude({ images: [base64Jpeg], prompt, schema: SCHEMA, apiKey, model });
  return parsed.cards
    .map((c) => ({ front: c.front.trim(), back: c.back.trim(), ok: true }))
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

// Foto('s) van een "Stone" (schema met zinsdelen in vakjes) → oefeningen met varianten.
export async function claudeStone(base64Jpegs, apiKey, { model = 'claude-opus-5-5' } = {}) {
  const prompt = `Dit is een "Stone" uit het Engelse schoolboek Stepping Stones (brugklas, Nederlandse leerling van 12–13 jaar).
Een Stone is een schema van zinsdelen in vakjes, verbonden met lijnen: elk pad door de vakjes vormt een zin (vraag of antwoord).
De school zegt: "Leer de Stones net als de woordjes. Herhaal, varieer en schrijf op! Verander bijvoorbeeld de onderwerpen,
werkwoorden en andere vocabulaire. Leerlingen moeten de Stones ook kunnen toepassen in een lopende tekst."

Maak oefeningen waarmee de leerling de zinsbouw van deze Stone leert. De leerling schrijft zijn antwoord op papier en kijkt
daarna zelf na met jouw antwoord. Doe dit:
1. Lees alle zinnen die het schema maakt (alle paden door de vakjes). "title" is de titel van de Stone, bv. "Stone 2 – Talking about personal information".
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
4. "pattern" is het patroon in het Engels met het variabele deel tussen haakjes, bv. "When is your birthday? – My birthday is on the (17th) of (May)."
5. "alternatives": andere goede antwoorden (bv. "I'm" naast "I am", "It's" naast "It is", andere woordvolgorde die ook klopt).
   Laat leeg als er geen zijn.
6. Maak in totaal 15 tot 30 oefeningen. Verzin geen grammatica die niet in de Stone staat.
De foto kan scheef of op z'n kant staan. Is het geen Stone of is hij onleesbaar, geef dan een lege lijst.`;

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

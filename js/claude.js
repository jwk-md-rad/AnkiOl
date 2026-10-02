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

export async function claudePairs(base64Jpeg, apiKey, { frontLang = 'en', backLang = 'nl', model = 'claude-opus-5-5' } = {}) {
  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const front = LANG_NAMES[frontLang] || frontLang;
  const back = LANG_NAMES[backLang] || backLang;

  const prompt = `Dit is een foto van een pagina uit een schoolboek met woordjes en/of zinnen om te leren (${front} en ${back}).
Maak er flashcards van:
- "front" is altijd de ${front} tekst, "back" de ${back} vertaling. Draai de volgorde om als het boek ze andersom geeft.
- Neem elk woord of elke zin over precies zoals in het boek staat, inclusief lidwoorden ("to" bij werkwoorden, "de/het" bij Nederlandse zelfstandige naamwoorden) als die erbij staan.
- Meerdere vertalingen voor één woord zet je samen in "back", gescheiden door komma's.
- Sla kopjes, paginanummers, uitspraaktekens (fonetisch schrift), oefeningen en uitleg over.
- Staat er een voorbeeldzin met vertaling bij, maak daar dan een aparte kaart van.
- Verzin niets wat niet op de foto staat. Is de foto onleesbaar, geef dan een lege lijst.`;

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude kon deze foto niet verwerken.');
  if (response.stop_reason === 'max_tokens') throw new Error('Te veel tekst op één foto; probeer een kleiner stuk.');
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Geen antwoord van Claude ontvangen.');
  const parsed = JSON.parse(textBlock.text);
  return parsed.cards
    .map((c) => ({ front: c.front.trim(), back: c.back.trim(), ok: true }))
    .filter((c) => c.front && c.back);
}

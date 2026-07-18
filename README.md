# AvtoMol AI Agent

AI консултант за AvtoMol.com. Помага с авточасти, гуми, масла, акумулатори и аксесоари.

## Какво знае

- Чете каталог от `https://avtomol.com/products.json`.
- Добавя гуми от публичната страница на `https://diana-ltd.com/tires`.
- Разпознава марка автомобил, модел, година, тип част, размер гума, сезон и марка гума.
- Ако няма точен резултат, насочва клиента към Viber/WhatsApp `0876 778 357`.
- Правило за запитване: клиентът изпраща марка, модел, година, VIN/рама или снимка на талона и частта, която търси.

## Стартиране

```bash
npm install
npm run import:catalog
npm start
```

Локален адрес:

```text
http://localhost:3000
```

Проверка:

```text
http://localhost:3000/health
```

## Код за Shopify

След като приложението е качено в Render, сложи този код преди `</body>` в Shopify `theme.liquid`.

```html
<script
  src="https://YOUR-RENDER-APP.onrender.com/agent-widget.js"
  data-api-base="https://YOUR-RENDER-APP.onrender.com"
  data-title="AvtoMol AI консултант"
  data-subtitle="Авточасти, гуми, масла и акумулатори"
  data-primary-color="#c90018"
  async
></script>
```

Смени `YOUR-RENDER-APP.onrender.com` с реалния Render адрес.

## Render настройки

- Build Command: `npm install`
- Start Command: `npm start`
- Environment:
  - `PORT` се задава автоматично от Render
  - `OPENAI_API_KEY` е по желание
  - `ALLOWED_ORIGINS=*`

Ако не сложиш OpenAI ключ, агентът пак работи в локален режим с каталога и правилата.


## НИКОЛАЙ – главен агент за растеж и контрол

НИКОЛАЙ проверява ежедневно AvtoMol.com, MegaMoll.bg, Posejdon.bg и WaterBG, подготвя по една статия за всеки сайт и органични публикации за Facebook, Instagram, TikTok, Viber и Google Free Listings.

Освен това:

- следи SEO, robots.txt, sitemap.xml, canonical, JSON-LD и ALT текстовете;
- чете Google Search Console, Google Ads и Shopify, когато са добавени защитените достъпи;
- следи продажби, запитвания, рекламни разходи и подчинените автоматизации;
- създава продуктови емисии за Google Merchant, Meta и TikTok;
- записва пълен отчет на работния плот;
- не изтрива страници или продукти и не стартира платен разход без одобрен лимит.

Ръчно стартиране:

```bash
npm run growth:run
```

Локалният отчет е в `growth-output/ПОСЛЕДЕН-ОТЧЕТ.html`. На компютъра се копира в `D:\Desktop\AI-АГЕНТ-ОТЧЕТ`.

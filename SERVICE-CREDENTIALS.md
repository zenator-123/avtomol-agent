# Служебни достъпи без ежедневна ръчна смяна

Автоматизациите използват постоянни служебни данни и сами издават краткотрайните работни токени, когато платформата го изисква.

- Meta/Facebook: един `META_SYSTEM_USER_ACCESS_TOKEN`, създаден от Meta Business Portfolio System User и с достъп до всички управлявани страници. Той има предимство пред старите Page токени.
- Shopify: `SHOPIFY_*_CLIENT_ID` и `SHOPIFY_*_CLIENT_SECRET`. Работният access token се издава автоматично при всяко изпълнение. Старият access token остава резервен вариант.
- OLX: `OLX_CLIENT_ID`, `OLX_CLIENT_SECRET` и `OLX_REFRESH_TOKEN`. Access token се подновява автоматично.
- Google Ads: постоянен OAuth client и refresh token; access token се подновява автоматично.
- Google Search Console: служебен акаунт чрез `GOOGLE_SERVICE_ACCOUNT_JSON`.
- GitHub Actions: `GITHUB_TOKEN` се издава автоматично за всяко изпълнение.

Служебните данни могат да бъдат отменени от собственика, при премахване на приложението или страницата, промяна на разрешенията или защитно действие на платформата. Това не е нормално ежедневно изтичане.

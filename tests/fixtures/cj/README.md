# CJ provider fixtures

These deterministic fixtures are transcribed from CJ's official documentation:

- `order-update.json`: the ORDER/UPDATE example in the [Webhook API](https://developers.cjdropshipping.com/en/api/api2/api/webhook.html). The documentation's malformed `orderItems` bracket is normalized to valid JSON without changing its fields or values.
- `get-access-token-success.json`: the success response for `POST /authentication/getAccessToken` in the [Authentication API](https://developers.cjdropshipping.com/en/api/api2/api/auth.html).
- `refresh-access-token-success.json`: the success response for `POST /authentication/refreshAccessToken` on the same page. Its deliberate omission of `openId` is part of the rotation regression.

Secrets are documentation placeholders only. Tests remain offline and never call CJ.

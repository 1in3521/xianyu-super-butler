import asyncio
import unittest
from unittest.mock import patch

import httpx

from app.reply_server import (
    ACCOUNT_DELIVERY_CODES_URL,
    ACCOUNT_DELIVERY_POOLS_URL,
    _account_delivery_bearer,
    app,
    get_account_delivery_pools,
)


def _card(url=ACCOUNT_DELIVERY_CODES_URL, authorization="Bearer PRIVATE_TOKEN"):
    return {
        "type": "api",
        "api_config": {
            "url": url,
            "method": "POST",
            "headers": {"Authorization": authorization},
        },
    }


class _HttpClient:
    response = httpx.Response(200, json=[])
    calls = []

    def __init__(self, **options):
        self.options = options

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def get(self, url, **options):
        self.calls.append((url, options, self.options))
        return self.response


class AccountDeliveryPoolsTests(unittest.TestCase):
    def setUp(self):
        _HttpClient.calls = []
        _HttpClient.response = httpx.Response(200, json=[])

    def test_only_exact_internal_delivery_connection_is_used(self):
        cards = [
            _card("http://attacker.test/api/delivery/codes"),
            _card("http://delivery-gateway:8081/api/delivery/codes?next=evil"),
            _card(authorization="Bearer PRIVATE_TOKEN\r\nX-Leak: yes"),
            _card(),
        ]
        with patch("app.reply_server.db_manager.get_all_cards", return_value=cards) as get_cards:
            self.assertEqual("PRIVATE_TOKEN", _account_delivery_bearer(7))
        get_cards.assert_called_once_with(7)

    def test_requires_login(self):
        async def request():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                return await client.get("/account-delivery/pools")

        response = asyncio.run(request())
        self.assertEqual(401, response.status_code)
        self.assertEqual({"success": False, "message": "请先登录"}, response.json())

    def test_missing_connection_is_actionable(self):
        with patch("app.reply_server.db_manager.get_all_cards", return_value=[]):
            response = asyncio.run(get_account_delivery_pools({"user_id": 7}))
        self.assertEqual(503, response.status_code)
        self.assertIn("高级配置", response.body.decode())

    def test_success_returns_only_pool_ids_and_names_from_fixed_gateway(self):
        _HttpClient.response = httpx.Response(200, json=[
            {"id": "pool-1", "name": "机械狂欢", "inventory": 99, "secret": "UPSTREAM_SECRET"}
        ])
        with (
            patch("app.reply_server.db_manager.get_all_cards", return_value=[_card()]),
            patch("app.reply_server.httpx.AsyncClient", _HttpClient),
        ):
            result = asyncio.run(get_account_delivery_pools({"user_id": 7}))

        self.assertEqual({"success": True, "pools": [{"id": "pool-1", "name": "机械狂欢"}]}, result)
        self.assertNotIn("UPSTREAM_SECRET", str(result))
        url, options, client_options = _HttpClient.calls[0]
        self.assertEqual(ACCOUNT_DELIVERY_POOLS_URL, url)
        self.assertEqual("Bearer PRIVATE_TOKEN", options["headers"]["Authorization"])
        self.assertFalse(client_options["follow_redirects"])
        self.assertFalse(client_options["trust_env"])

    def test_upstream_error_does_not_reflect_response_body_or_secret(self):
        _HttpClient.response = httpx.Response(401, text="PRIVATE_TOKEN UPSTREAM_SECRET")
        with (
            patch("app.reply_server.db_manager.get_all_cards", return_value=[_card()]),
            patch("app.reply_server.httpx.AsyncClient", _HttpClient),
        ):
            response = asyncio.run(get_account_delivery_pools({"user_id": 7}))

        self.assertEqual(502, response.status_code)
        self.assertNotIn("PRIVATE_TOKEN", response.body.decode())
        self.assertNotIn("UPSTREAM_SECRET", response.body.decode())

    def test_redirect_is_not_followed(self):
        _HttpClient.response = httpx.Response(
            302, headers={"Location": "http://attacker.test/collect"}
        )
        with (
            patch("app.reply_server.db_manager.get_all_cards", return_value=[_card()]),
            patch("app.reply_server.httpx.AsyncClient", _HttpClient),
        ):
            response = asyncio.run(get_account_delivery_pools({"user_id": 7}))
        self.assertEqual(502, response.status_code)
        self.assertEqual(1, len(_HttpClient.calls))

    def test_invalid_pool_list_is_rejected(self):
        _HttpClient.response = httpx.Response(200, json={"data": [{"id": "pool-1"}]})
        with (
            patch("app.reply_server.db_manager.get_all_cards", return_value=[_card()]),
            patch("app.reply_server.httpx.AsyncClient", _HttpClient),
        ):
            response = asyncio.run(get_account_delivery_pools({"user_id": 7}))
        self.assertEqual(502, response.status_code)
        self.assertIn("列表无效", response.body.decode())


if __name__ == "__main__":
    unittest.main()

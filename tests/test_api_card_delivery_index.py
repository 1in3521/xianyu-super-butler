import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

import aiohttp
from loguru import logger

from XianyuAutoAsync import XianyuLive


class _Response:
    def __init__(self, status, body):
        self.status = status
        self.body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def text(self):
        return self.body


class ApiCardDeliveryIndexTests(unittest.TestCase):
    def _call_after_failure(self, first_result):
        live = object.__new__(XianyuLive)
        live.cookie_id = "seller-1"
        live.session = Mock()
        live.session.post = Mock(
            side_effect=[first_result, _Response(200, '{"data":"CODE-2"}')]
        )
        manager = Mock()
        manager.get_order_by_id.return_value = {"order_id": "order-1"}
        manager.get_item_info.return_value = {"item_detail": ""}
        rule = {
            "api_config": {
                "url": "https://example.test/deliveries",
                "method": "POST",
                "timeout": 10,
                "headers": {},
                "params": {
                    "shopId": "{cookie_id}",
                    "orderId": "{order_id}",
                    "itemId": "{item_id}",
                    "deliveryIndex": "{delivery_index}",
                },
            }
        }

        with (
            patch("app.db_manager.db_manager", manager),
            patch("asyncio.sleep", new_callable=AsyncMock),
        ):
            content = asyncio.run(
                live._get_api_card_content(
                    rule, "order-1", "item-1", "buyer-1", delivery_index=2
                )
            )

        self.assertEqual("CODE-2", content)
        self.assertEqual(2, live.session.post.call_count)
        payloads = [call.kwargs["json"] for call in live.session.post.call_args_list]
        self.assertEqual(payloads[0], payloads[1])
        self.assertEqual(
            {
                "shopId": "seller-1",
                "orderId": "order-1",
                "itemId": "item-1",
                "deliveryIndex": "2",
            },
            payloads[0],
        )

    def test_http_server_error_retries_the_same_delivery_index(self):
        self._call_after_failure(_Response(503, "temporarily unavailable"))

    def test_network_timeout_retries_the_same_delivery_index(self):
        self._call_after_failure(asyncio.TimeoutError())

    def test_api_logs_do_not_include_configured_secrets(self):
        live = object.__new__(XianyuLive)
        live.cookie_id = "seller-1"
        live.session = Mock()
        live.session.post = Mock(
            side_effect=aiohttp.ClientError("CLIENT_SECRET")
        )
        rule = {
            "api_config": {
                "url": "https://example.test/deliveries?key=URL_SECRET",
                "method": "POST",
                "headers": {"Authorization": "Bearer HEADER_SECRET"},
                "params": {"secret": "BODY_SECRET"},
            }
        }
        messages = []
        sink_id = logger.add(lambda message: messages.append(message.record["message"]))
        try:
            with patch("asyncio.sleep", new_callable=AsyncMock):
                content = asyncio.run(live._get_api_card_content(rule))
        finally:
            logger.remove(sink_id)

        self.assertIsNone(content)
        self.assertEqual(4, live.session.post.call_count)
        logged = "\n".join(messages)
        for secret in ("URL_SECRET", "HEADER_SECRET", "BODY_SECRET", "CLIENT_SECRET"):
            self.assertNotIn(secret, logged)


if __name__ == "__main__":
    unittest.main()

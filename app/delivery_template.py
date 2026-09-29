"""Send a single delivery payload through the active Xianyu connection."""


async def send_payload(instance, websocket, chat_id, buyer_id, content):
    if content.startswith("__IMAGE_SEND__"):
        image_data = content[len("__IMAGE_SEND__"):]
        card_id = None
        image_url = image_data
        if "|" in image_data:
            card_id_text, image_url = image_data.split("|", 1)
            try:
                card_id = int(card_id_text)
            except ValueError:
                card_id = None
        await instance.send_image_msg(websocket, chat_id, buyer_id, image_url, card_id=card_id)
    else:
        await instance.send_msg(websocket, chat_id, buyer_id, content)
    return 1

# Capability Map

`op_wx_onebotv11` is intentionally scoped to the **official OpenClaw Weixin direct-chat capability set** and maps only the parts that can be implemented honestly as OneBot v11.

## Supported OneBot v11 actions

- `send_private_msg`
- `send_msg` (`message_type=private` only)
- `get_login_info`
- `get_status`
- `get_version_info`
- `can_send_image` (returns `false`)
- `can_send_record`

## Supported OneBot v11 events

- `message.private`
- `meta_event.lifecycle`
- `meta_event.heartbeat`

## Message capability mapping

### Inbound
- text -> `text`
- image -> `image`
- voice(text available) -> `text`
- voice(binary only) -> `record`
- file -> `file`
- video -> `video`

### Outbound
- `text` -> official `sendmessage`
- `image` -> not implemented
- `video` -> not implemented
- `file` -> not implemented
- `record` -> not implemented yet

## Explicitly unsupported in current version

These are not exposed because the official Weixin channel capability does not provide them today:

- group chat actions/events
- friend/group/member list APIs
- recall/delete/history/forward APIs
- outbound image / GIF / video / file
- outbound record send

## Notes

- `self_id` and `user_id` are strings.
- String messages support CQ parsing by default; set `auto_escape=true` to treat them as plain text.
- The implementation follows the official OpenClaw Weixin media flow instead of the unofficial `uploadmedia` pattern.

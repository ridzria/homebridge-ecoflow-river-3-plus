"""Generate test/fixtures/reference.json from the hassio-ecoflow-cloud project.

The fixtures are built with that project's generated protobuf classes
(ef_river3_pb2.py), following the same steps as its River 3 code, so the
plugin's encoder and decoder can be checked against an independent
implementation.

Usage:
    python make_reference_fixtures.py /path/to/dir/containing/ef_river3_pb2.py > test/fixtures/reference.json

Needs the "protobuf" package (6.32 or newer).
"""
import json
import sys

sys.path.insert(0, sys.argv[1])
import ef_river3_pb2 as pb  # noqa: E402
from google.protobuf.json_format import MessageToDict  # noqa: E402

SN = "R631ZEB4XF123456"


def command(field, value, seq, data_len=None):
    # Mirrors _create_river3_proto_command in devices/internal/river3.py
    payload = pb.River3SetCommand()
    setattr(payload, field, int(value))
    pdata = payload.SerializeToString()
    packet = pb.River3SendHeaderMsg()
    message = packet.msg.add()
    message.src = 32
    message.dest = 2
    message.d_src = 1
    message.d_dest = 1
    message.cmd_func = 254
    message.cmd_id = 17
    message.need_ack = 1
    message.seq = seq
    message.product_id = 1
    message.version = 19
    message.payload_ver = 1
    message.device_sn = SN
    message.data_len = data_len if data_len is not None else len(pdata)
    message.pdata = pdata
    return {"field": field, "value": value, "seq": seq, "sn": SN, "hex": packet.SerializeToString().hex()}


def xor(data, seq):
    return bytes((b ^ seq) & 0xFF for b in data)


def header(cmd_func, cmd_id, body, seq=0, enc_type=0, src=2):
    h = pb.River3Header()
    h.src = src
    h.dest = 32
    h.enc_type = enc_type
    h.cmd_func = cmd_func
    h.cmd_id = cmd_id
    h.seq = seq
    data = body.SerializeToString()
    h.data_len = len(data)
    h.pdata = xor(data, seq) if enc_type == 1 and src != 32 else data
    return h


def envelope(*headers):
    msg = pb.River3HeaderMessage()
    for h in headers:
        msg.header.append(h)
    return msg.SerializeToString()


def plain(body):
    return MessageToDict(body, preserving_proto_field_name=True)


def telemetry():
    cases = []

    display = pb.River3DisplayPropertyUpload()
    display.cms_batt_soc = 87.5
    display.bms_batt_soc = 88.0
    display.pow_in_sum_w = 120.25
    display.pow_out_sum_w = 58.0
    display.pow_get_ac_out = -46.5
    display.pow_get_12v = -11.5
    display.flow_info_ac_out = 2
    display.flow_info_12v = 0
    display.xboost_en = 1
    display.led_mode = 2
    display.plug_in_info_ac_charger_flag = 1
    display.cms_chg_dsg_state = 2
    display.bms_min_cell_temp = -3
    item = display.display_statistics_sum.list_info.add()
    item.statistics_object = pb.STATISTICS_OBJECT_AC_OUT_ENERGY
    item.statistics_content = 4321
    expected = plain(display)
    expected.pop("display_statistics_sum")
    expected["ac_out_energy"] = 4321
    cases.append({
        "name": "display upload, XOR scrambled",
        "hex": envelope(header(254, 21, display, seq=0x3B9A4C6F, enc_type=1)).hex(),
        "expected": expected,
    })
    cases.append({
        "name": "display upload, plain",
        "hex": envelope(header(254, 21, display)).hex(),
        "expected": expected,
    })

    runtime = pb.River3RuntimePropertyUpload()
    runtime.temp_pcs_dc = 31.5
    runtime.plug_in_info_ac_in_vol = 239.75
    runtime.bms_full_cap = 13950
    off = pb.River3DisplayPropertyUpload()
    off.flow_info_ac_out = 0
    off.pow_get_ac_out = 0.0
    merged = plain(off)
    merged.update(plain(runtime))
    cases.append({
        "name": "two headers in one payload",
        "hex": envelope(header(254, 21, off, seq=77, enc_type=1), header(254, 22, runtime, seq=78, enc_type=1)).hex(),
        "expected": merged,
    })

    reply = pb.River3SetReply()
    reply.config_ok = True
    reply.cfg_ac_out_open = 1
    cases.append({
        "name": "accepted set reply",
        "hex": envelope(header(254, 18, reply, seq=5, enc_type=1)).hex(),
        "expected": plain(reply),
    })

    refused = pb.River3SetReply()
    refused.config_ok = False
    refused.cfg_ac_out_open = 1
    cases.append({
        "name": "refused set reply is ignored",
        "hex": envelope(header(254, 18, refused)).hex(),
        "expected": {},
    })

    backup = pb.River3SetReply()
    backup.config_ok = True
    backup.cfg_energy_backup.energy_backup_en = 1
    backup.cfg_energy_backup.energy_backup_start_soc = 30
    cases.append({
        "name": "nested fields are flattened",
        "hex": envelope(header(254, 18, backup)).hex(),
        "expected": {
            "config_ok": True,
            "cfg_energy_backup_energy_backup_en": 1,
            "cfg_energy_backup_energy_backup_start_soc": 30,
        },
    })

    bms = pb.River3BMSHeartBeatReport()
    bms.soc = 87
    bms.cycles = 12
    bms.temp = 24
    bms.f32_show_soc = 87.25
    cases.append({
        "name": "BMS heartbeat",
        "hex": envelope(header(32, 50, bms, seq=9, enc_type=1)).hex(),
        "expected": plain(bms),
    })

    cms = pb.River3CMSHeartBeatReport()
    cms.msg32_2_1.cms_batt_soc = 64.5
    cms.msg32_2_1.cms_max_chg_soc = 100
    cases.append({
        "name": "CMS heartbeat",
        "hex": envelope(header(32, 2, cms)).hex(),
        "expected": {"msg32_2_1_cms_batt_soc": 64.5, "msg32_2_1_cms_max_chg_soc": 100},
    })
    return cases


json.dump(
    {
        "source": "hassio-ecoflow-cloud ef_river3_pb2.py, protobuf " + __import__("google.protobuf").protobuf.__version__,
        "commands": [
            command("cfg_ac_out_open", 1, 999912345),
            command("cfg_ac_out_open", 0, 999954321),
            command("cfg_dc12v_out_open", 1, 999910000),
            command("xboost_en", 0, 999999999),
            command("cfg_led_mode", 2, 999955555),
            command("en_beep", 1, 999911111, data_len=2),
        ],
        "telemetry": telemetry(),
    },
    sys.stdout,
    indent=2,
)

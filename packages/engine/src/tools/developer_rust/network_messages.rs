use crate::RunContext;

pub fn message(ctx: &RunContext<'_>, key: &str) -> Option<&'static str> {
    let zh = ctx.locale.starts_with("zh");
    Some(match key {
        "dev.error.tooLarge" => {
            if zh {
                "内容过大，请使用不超过 8 MB 的文件或内容。"
            } else {
                "The content is too large. Use a file or content no larger than 8 MB."
            }
        }
        "dev.error.regex" => {
            if zh {
                "正则表达式或标记无效，请检查表达式和标记。"
            } else {
                "The regular expression or flags are invalid. Check the expression and flags."
            }
        }
        "dev.error.regexTimeout" => {
            if zh {
                "表达式执行时间过长，已停止。请简化表达式或缩短输入。"
            } else {
                "The expression took too long and was stopped. Simplify it or shorten the input."
            }
        }
        "dev.regex.noMatches" => {
            if zh {
                "没有找到匹配项。"
            } else {
                "No matches found."
            }
        }
        "dev.error.hostname" => {
            if zh {
                "请输入有效的域名。"
            } else {
                "Enter a valid hostname."
            }
        }
        "dev.error.dnsType" => {
            if zh {
                "不支持此 DNS 记录类型。"
            } else {
                "This DNS record type is not supported."
            }
        }
        "dev.error.dnsLookup" => {
            if zh {
                "DNS 查询失败。请检查域名、网络连接或系统 DNS 设置后重试。"
            } else {
                "DNS lookup failed. Check the hostname, network connection, or system DNS settings and try again."
            }
        }
        "dev.error.pingUnavailable" => {
            if zh {
                "当前系统无法启动 Ping 命令。"
            } else {
                "Could not start the Ping command on this system."
            }
        }
        "dev.error.networkUnavailable" => {
            if zh {
                "无法读取本机网络检测结果，请重试。"
            } else {
                "Could not read the local network check result. Try again."
            }
        }
        "dev.error.ipLookupAddress" => {
            if zh {
                "请输入有效的 IPv4 或 IPv6 地址。"
            } else {
                "Enter a valid IPv4 or IPv6 address."
            }
        }
        "dev.error.ipLookupNetwork" => {
            if zh {
                "暂时无法连接宝塔 IP 查询服务，请检查网络后重试。"
            } else {
                "Could not reach Baota’s IP lookup service. Check your network and try again."
            }
        }
        "dev.error.ipLookupResponse" => {
            if zh {
                "宝塔 IP 查询服务返回了无法识别的数据，请稍后重试。"
            } else {
                "Baota’s IP lookup service returned data in an unrecognized format. Try again later."
            }
        }
        "dev.localNetwork.dns" => {
            if zh {
                "系统 DNS 服务器"
            } else {
                "System DNS servers"
            }
        }
        "dev.localNetwork.interface" => {
            if zh {
                "网络接口"
            } else {
                "Network interface"
            }
        }
        "dev.localNetwork.mac" => "MAC",
        "dev.localNetwork.loopback" => {
            if zh {
                "本机回环"
            } else {
                "Loopback"
            }
        }
        "dev.localNetwork.active" => {
            if zh {
                "接口地址"
            } else {
                "Interface address"
            }
        }
        "dev.localNetwork.target" => {
            if zh {
                "检测目标"
            } else {
                "Target"
            }
        }
        "dev.localNetwork.status" => {
            if zh {
                "结果"
            } else {
                "Result"
            }
        }
        "dev.localNetwork.reachable" => {
            if zh {
                "收到回应"
            } else {
                "Reply received"
            }
        }
        "dev.localNetwork.unreachable" => {
            if zh {
                "未收到回应（可能被防火墙拦截）"
            } else {
                "No reply received (a firewall may be blocking it)"
            }
        }
        "dev.localNetwork.connected" => {
            if zh {
                "TCP 连接成功"
            } else {
                "TCP connection succeeded"
            }
        }
        "dev.localNetwork.refused" => {
            if zh {
                "连接失败或被拒绝"
            } else {
                "Connection failed or was refused"
            }
        }
        "dev.localNetwork.timeout" => {
            if zh {
                "连接超时"
            } else {
                "Connection timed out"
            }
        }
        "dev.localNetwork.elapsed" => {
            if zh {
                "耗时"
            } else {
                "Elapsed time"
            }
        }
        "dev.localNetwork.errorCode" => {
            if zh {
                "系统错误码"
            } else {
                "System error code"
            }
        }
        "dev.ipLookup.queryType" => {
            if zh {
                "查询方式"
            } else {
                "Lookup mode"
            }
        }
        "dev.ipLookup.localPublicIP" => {
            if zh {
                "本机公网 IP"
            } else {
                "This computer’s public IP"
            }
        }
        "dev.ipLookup.customIP" => {
            if zh {
                "指定 IP"
            } else {
                "Specified IP"
            }
        }
        "dev.ipLookup.ip" => {
            if zh {
                "IP 地址"
            } else {
                "IP address"
            }
        }
        "dev.ipLookup.continent" => {
            if zh {
                "洲/大洲"
            } else {
                "Continent"
            }
        }
        "dev.ipLookup.country" => {
            if zh {
                "国家/地区"
            } else {
                "Country or region"
            }
        }
        "dev.ipLookup.countryCode" => {
            if zh {
                "国家代码"
            } else {
                "Country code"
            }
        }
        "dev.ipLookup.region" => {
            if zh {
                "省/州"
            } else {
                "State or province"
            }
        }
        "dev.ipLookup.city" => {
            if zh {
                "城市"
            } else {
                "City"
            }
        }
        "dev.ipLookup.county" => {
            if zh {
                "县/区"
            } else {
                "County or district"
            }
        }
        "dev.ipLookup.isp" => "ISP",
        "dev.ipLookup.zipcode" => {
            if zh {
                "邮政编码"
            } else {
                "Postal code"
            }
        }
        "dev.ipLookup.coordinates" => {
            if zh {
                "坐标（纬度，经度）"
            } else {
                "Coordinates (latitude, longitude)"
            }
        }
        "dev.ipLookup.source" => {
            if zh {
                "数据来源"
            } else {
                "Data source"
            }
        }
        _ => return None,
    })
}

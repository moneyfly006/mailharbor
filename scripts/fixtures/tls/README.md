# 测试用自签名证书

仅用于本地单测：模拟「企业自建 IMAP/SMTP + 自签名证书」的场景，验证
「允许自签名证书」开关是否生效。**不要用于生产**。

重新生成：
```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=MailHarbor Test" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

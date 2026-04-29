const http = require('http');

fetch("http://localhost:3001/api/locations/counties", {
  headers: {
    "X-Tenant-ID": "b2c6a0c2-559d-4e94-9214-72b9a7164ff2"
  }
}).then(r => r.text()).then(console.log).catch(console.error);

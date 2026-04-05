
# Linux App Path
```
~/bin // Thư mục chứa executable cá nhân 
/usr/local/bin // Thư mục chứa executable toàn bộ user hệ thống
```

# Tạo File Executable
```
#!/bin/bash
node /home/light/workspace/ai/smartwriter-mcp/dist/index.js "$@"
```

# Cấp quyền cho File Executable:
```
chmod +x ~/workspace/ai/smartwriter-mcp/dist/bin/smartwriter
```

# Thêm vào PATH .bashrc
```
export PATH=$PATH:~/workspace/ai/smartwriter-mcp/dist/bin
```



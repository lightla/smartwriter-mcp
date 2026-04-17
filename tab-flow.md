mình muốn bổ sung 1 tính năng tab flow, tức là liên tab

1. Trong menu Smartwriter MCP (Browser bridge) có 1 toggle on/off tab flow

2. Khi Tab flow off: mọi thứ logic như cũ 

3. Khi Tab flow on 

3.1. Bỏ hết không còn button: connect this tab, focus connected tab, tracking on

3.2. ngay trên bottom right padding 5 có 1 button (Ý nghĩa của nó là first tab connected)

3.3. mở sang 1 tab khác, cũng có 1 button tương tự (Ý nghĩa của nó là second tab connected)

Tạm gọi là: icon current connected 

+ Khi connected -> luôn ở trạng thái tracking: on 
+ Focus mode: OFF  


+ Bổ sung 1 tool:
  + get_flowed_tab_ids: trả về Danh sách tab id connected sort theo thứ tự 
  (PSV format)

OUTPUT = t:1, t:2, t:3
(Giống anotation id marked là a:1)


Tool hiện có:
+ click tab cần cho phép nhận marked
  + t:1 
  => Tool tự lấy get_tabs để tìm ra tab id tương ứng với t:1 để click 

  => Agent k cần biết tới tabId hay tabLink (đỡ tôn token)


Nếu tabflow off (chrome tabflow off)
  => get_flow_tabIds = empty

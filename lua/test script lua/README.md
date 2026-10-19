# ทดสอบส่งข้อมูลเข้า AXION Workspace

ไฟล์ทดสอบนี้ใช้ข้อมูลจำลองและแยก workspace ออกจากข้อมูลบัญชีจริง:

- `gamescope`: `AXION_TEST`
- `accountId`: `{RobloxUserId}_TEST`
- ไอเทมทดสอบ 5 ชิ้น: `AXION_TEST_ITEM1` ถึง `AXION_TEST_ITEM5` (อยู่ในหมวด `materials`)

ข้อมูลถูกบันทึกใน `Database/Workspace/AXION_TEST/{RobloxUserId}_TEST.json` ภายในโฟลเดอร์ App Data ของ AXION

## ตั้งค่า

1. เปิด AXION แล้วไปที่ **Server Scripts**.
2. ในช่อง Game scope ใส่ `AXION_TEST` แล้วกด **Apply game scope**.
3. กด **Copy AXION API** แล้วแก้ค่าในส่วน CONFIG ของโค้ดที่คัดลอก:

   ```lua
   WebSocketHost = 5242,
   gamescope = "AXION_TEST",
   ```

   `WebSocketHost` ใช้เฉพาะเลข port ของ WebSocket (ค่าเริ่มต้น `5242`). หากเปลี่ยนพอร์ตใน AXION ให้คัดลอก API ใหม่เพื่อให้ `WebSocketHost` และ `ScriptApiPort` ตรงกันด้วย
4. โหลด AXION API ที่แก้ CONFIG แล้วใน executor และรอจนเชื่อมต่อ AXION WebSocket สำเร็จ. ไฟล์ทดสอบจะตรวจว่า `AXION.gamescope` เป็น `AXION_TEST`; ถ้าไม่ตรง ปุ่มจะแสดงข้อผิดพลาดแทนการส่งข้อมูลผิด scope.
5. ในหน้า Server Scripts เพิ่ม Server Script แล้ววางเนื้อหาจาก [`server.lua`](./server.lua) จากนั้นกด Save
   ชื่อที่แสดงในรายการตั้งอะไรก็ได้ แต่โค้ดต้อง export ฟังก์ชันชื่อ `test_workspace` และ Game scope ต้องเป็น `AXION_TEST`.
6. นำโค้ดจาก [`local.lua`](./local.lua) ไปรันใน executor หลังจาก AXION API เชื่อมต่อแล้ว.
7. ในหน้าต่างทดสอบ วาง API token จากหน้า Server Scripts ลงในช่อง token.
8. กด **1. Send test data to AXION**. สถานะในเกมยืนยันเฉพาะว่า client ส่ง WebSocket message แล้ว; ต้องเห็นข้อความ **Saved workspace received** ในหน้า Server Scripts ของ AXION จึงยืนยันได้ว่า server ตรวจและบันทึกไฟล์สำเร็จ.
9. กด **2. Read it back from the database**. ควรเห็น `Database read OK · 5/5 test items` พร้อมชื่อและจำนวนของทั้ง 5 ชิ้น ซึ่งยืนยันว่า Server Script อ่านหลายรายการจาก workspace ของบัญชีทดสอบได้.
10. ตรวจข้อมูลเต็มได้ในแท็บ **Database** โดยเลือก scope `AXION_TEST`. บัญชีทดสอบจะแสดงท้าย ID ด้วย `_TEST`.

## หมายเหตุ

- ต้องตั้ง `gamescope` ใน AXION API และ Game scope ของหน้า Server Scripts เป็น `AXION_TEST` เหมือนกัน เพราะ `AXION:Fetch` ใช้ scope จาก API CONFIG.
- HTTP request ของ `AXION:Fetch` ต้องเข้าถึง localhost บนเครื่องที่เปิด AXION; executor ต้องรองรับ API `request`.
- `ReportWorkspace` ไม่มี rate limit ตามเวลา แต่ยังจำกัดขนาด WebSocket และ schema ของข้อมูล.
- ระบบรองรับหลายไอเทมในหมวดเดียวกัน โดยใช้ชื่อไอเทมเป็น key เช่น `materials = { ["AXION_TEST_ITEM1"] = { quantity = 7 }, ["AXION_TEST_ITEM2"] = { quantity = 14 } }`. การส่งซ้ำจะเขียนทับข้อมูลของหมวดที่ส่งมา ไม่ได้เพิ่ม quantity ให้รายการเดิมโดยอัตโนมัติ.
- การส่งซ้ำจะปรับปรุง workspace ของบัญชีทดสอบเดิม ไม่สร้างไฟล์บัญชีใหม่ทุกครั้ง. ลบไฟล์ `{RobloxUserId}_TEST.json` ในโฟลเดอร์ `Database/Workspace/AXION_TEST` เมื่อต้องการล้างข้อมูลทดสอบ.
- อย่าใช้ test script กับบัญชีจริงโดยแก้ `accountId` ให้เป็น UserId จริง; ตัวอย่างนี้ตั้งใจใช้ suffix `_TEST`.

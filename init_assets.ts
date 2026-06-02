import * as xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';

const ASSETS_ROOT = process.env.ASSETS_ROOT || 'D:\\尚品易站图片';

if (!fs.existsSync(ASSETS_ROOT)) {
  fs.mkdirSync(ASSETS_ROOT, { recursive: true });
}

// 创建示例文件夹
const folders = ['产品A_抑菌系列', '产品B_真丝系列', '产品C_智能家居'];
folders.forEach(f => {
  const p = path.join(ASSETS_ROOT, f);
  if (!fs.existsSync(p)) fs.mkdirSync(p);
});

// 创建示例 Excel
const data = [
  { '产品名称': '产品A_抑菌系列', '抑菌率': '99.9%', '材质': '精梳棉', '规格': '200x230cm', '核心卖点': '长效抑菌，亲肤透气' },
  { '产品名称': '产品B_真丝系列', '抑菌率': 'N/A', '材质': '100% 桑蚕丝', '规格': '150x200cm', '核心卖点': '奢华光泽，美容养颜' },
  { '产品名称': '产品C_智能家居', '抑菌率': 'N/A', '材质': '铝合金', '规格': '标准', '核心卖点': '语音控制，自动感应' }
];

const ws = xlsx.utils.json_to_sheet(data);
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, ws, 'SellingPoints');
xlsx.writeFile(wb, path.join(ASSETS_ROOT, 'selling_points.xlsx'));

console.log('示例资产与卖点表已生成。');

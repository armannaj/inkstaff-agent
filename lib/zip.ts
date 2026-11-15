import "server-only";
import { crc32 } from "node:zlib";

/**
 * A zip archive of the files as they are (stored, not compressed: they're images, already compressed). Names are kept
 * as given, so they must be unique. Under 4 GB, which the 2 MB images of an article are far from.
 */
export function zip(files: { name: string; data: Buffer }[], date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(data);
    // Shared by the local header (from offset 4) and the central directory entry (from offset 6).
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0); // version needed: 2.0
    fields.writeUInt16LE(0x0800, 2); // UTF-8 names
    fields.writeUInt16LE(0, 4); // stored
    fields.writeUInt16LE(time, 6);
    fields.writeUInt16LE(day, 8);
    fields.writeUInt32LE(crc, 10);
    fields.writeUInt32LE(data.length, 14);
    fields.writeUInt32LE(data.length, 18);
    fields.writeUInt16LE(fileName.length, 22);
    fields.writeUInt16LE(0, 24); // no extra field

    const local = Buffer.alloc(4);
    local.writeUInt32LE(0x04034b50, 0);
    locals.push(local, fields, fileName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: 2.0
    fields.copy(central, 6);
    // 32: comment length, 34: disk, 36: internal attributes, 38: external attributes, all 0.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);

    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

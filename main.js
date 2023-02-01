import mysql from "mysql";
import util from "util";
import { load } from "cheerio";
import { basename, join } from "path";
import mime from "mime-types";
import * as readline from "node:readline/promises";
import {
  originDatabaseCredentials,
  targetDatabaseCredentials,
  targetFilePath,
} from "./config.mjs";
import { stdin as input, stdout as output } from "node:process";

const originConnection = mysql.createConnection(originDatabaseCredentials);
const queryOrigin = util
  .promisify(originConnection.query)
  .bind(originConnection);

const targetConnection = mysql.createConnection(targetDatabaseCredentials);
const queryTarget = util
  .promisify(targetConnection.query)
  .bind(targetConnection);

let filesProcessed = 0;
let totalFilesToDownload = -1;

async function main() {
  originConnection.connect();
  targetConnection.connect();

  try {
    console.log("Iniciando...");
    const totalFiles = await queryOrigin(
      "SELECT COUNT(*) as count FROM `qxe79_docman_documents` WHERE `enabled` = 1"
    );
    totalFilesToDownload = totalFiles[0].count;
    await queryTarget("DELETE FROM valor_lawsuits");
    await queryTarget("DELETE FROM valor_lawsuit_folders");
    await queryTarget(
      "DELETE FROM attachments WHERE attachable_type = 'valor_lawsuit_folders'"
    );

    const lawsuits = await queryOrigin(
      "SELECT `tbl`.*, `viewlevel`.`title` AS `access_title`, COUNT(`crumbs`.`ancestor_id`) AS `level`, GROUP_CONCAT(`crumbs`.`ancestor_id` ORDER BY `crumbs`.`level` DESC SEPARATOR '/') AS `path`, `_owner`.`id` AS `_owner_id`, `_owner`.`name` AS `_owner_name`, `_owner`.`username` AS `_owner_username`, `_owner`.`email` AS `_owner_email`, `_owner`.`params` AS `_owner_params`, `_owner`.`block` AS `_owner_block`, `_owner`.`activation` AS `_owner_activation`, `_owner`.`name` AS `locked_by_name`, `_author`.`id` AS `_author_id`, `_author`.`name` AS `_author_name`, `_author`.`username` AS `_author_username`, `_author`.`email` AS `_author_email`, `_author`.`params` AS `_author_params`, `_author`.`block` AS `_author_block`, `_author`.`activation` AS `_author_activation`, `_author`.`name` AS `created_by_name`, `_editor`.`id` AS `_editor_id`, `_editor`.`name` AS `_editor_name`, `_editor`.`username` AS `_editor_username`, `_editor`.`email` AS `_editor_email`, `_editor`.`params` AS `_editor_params`, `_editor`.`block` AS `_editor_block`, `_editor`.`activation` AS `_editor_activation`, `_editor`.`name` AS `modified_by_name`, `ordering2`.`custom` AS `ordering`, GROUP_CONCAT(LPAD(`ordering`.`custom`, 5, '0') ORDER BY `crumbs`.`level` DESC  SEPARATOR '/') AS `order_path` FROM `qxe79_docman_categories` AS `tbl` LEFT JOIN `qxe79_viewlevels` AS `viewlevel` ON (`tbl`.`access` = `viewlevel`.`id`) INNER JOIN `qxe79_docman_category_relations` AS `crumbs` ON (`crumbs`.`descendant_id` = `tbl`.`docman_category_id`) LEFT JOIN `qxe79_users` AS `_owner` ON (`tbl`.`locked_by` = `_owner`.`id`) LEFT JOIN `qxe79_users` AS `_author` ON (`tbl`.`created_by` = `_author`.`id`) LEFT JOIN `qxe79_users` AS `_editor` ON (`tbl`.`modified_by` = `_editor`.`id`) left JOIN `qxe79_docman_category_orderings` AS `ordering2` ON (`tbl`.`docman_category_id` = `ordering2`.`docman_category_id`) inner JOIN `qxe79_docman_category_orderings` AS `ordering` ON (`crumbs`.`ancestor_id` = `ordering`.`docman_category_id`) WHERE `tbl`.`enabled` = 1 AND (`tbl`.`created_by` = 0 OR `tbl`.`access` IN (1, 1, 5)) GROUP BY `tbl`.`docman_category_id` HAVING `level` IN (1) ORDER BY `order_path` ASC"
    );

    for (const lawsuit of lawsuits) {
      await processLawsuit(lawsuit);
    }
  } finally {
    originConnection.end();
    targetConnection.end();
  }
}

async function processLawsuit(lawsuit) {
  let optionalData = {
    author: "",
    processId: "",
    protocol: "",
    nature: "",
    distribution: "",
    judicialDistrict: "",
  };

  if (lawsuit.description) {
    const $ = load(lawsuit.description);

    const dataInTable = (search, limit = 255) => {
      let data = $("td")
        ?.filter(function () {
          return $(this).text().toLowerCase().includes(search.toLowerCase());
        })
        ?.next()
        ?.text()
        ?.trim();
      if (data == null) return null;
      if (data.length > limit) {
        data = data.slice(0, limit - 3) + "...";
      }
      return data;
    };

    optionalData.author = dataInTable("autor") ?? "";
    optionalData.processId = dataInTable("processo") ?? "";
    optionalData.protocol = dataInTable("protocolo");
    optionalData.nature = dataInTable("natureza");
    optionalData.distribution = dataInTable("distribuição");
    optionalData.judicialDistrict = dataInTable("comarca");
  }

  const resp = await queryTarget(
    "INSERT INTO valor_lawsuits (`order`, `title`, `author`, `process_number`, `protocol`, `nature`, `distribution`, `judicial_district`, `slug`, `status`, `comment`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
    [
      1,
      lawsuit.title,
      optionalData.author,
      optionalData.processId,
      optionalData.protocol,
      optionalData.nature,
      optionalData.distribution,
      optionalData.judicialDistrict,
      lawsuit.slug,
      1,
      1,
      lawsuit.created_on,
      new Date(),
    ]
  );

  await createLawsuitFolders(lawsuit, resp.insertId);
}

async function createLawsuitFolders(lawsuit, newLawsuitId) {
  const folders = await queryOrigin(
    "SELECT categories.docman_category_id, categories.title, categories.slug FROM qxe79_docman_categories AS categories JOIN qxe79_docman_category_relations AS relations ON relations.descendant_id = categories.docman_category_id WHERE relations.level = 1 AND relations.ancestor_id = ?",
    [lawsuit.docman_category_id]
  );

  for (const folder of folders) {
    const newFolder = await queryTarget(
      "INSERT INTO valor_lawsuit_folders (`valor_lawsuit_id`, `order`, `title`, `slug`, `status`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        newLawsuitId,
        1,
        folder.title,
        folder.slug,
        1,
        folder.created_on,
        new Date(),
      ]
    );
    await processFiles(folder, newFolder.insertId);
  }
}

async function processFiles(folder, newFolderId) {
  const files = await queryOrigin(
    "SELECT * FROM `qxe79_docman_documents` WHERE `docman_category_id` = ? AND `enabled` = 1",
    [folder.docman_category_id]
  );
  for (const file of files) {
    const filename = basename(file.storage_path);

    await queryTarget(
      "INSERT INTO attachments (`attachable_type`, `attachable_id`, `role`, `order`, `title`, `slug`, `disk`, `path`, `name`, `src`, `mime`, `status`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "valor_lawsuit_folders",
        newFolderId,
        "application",
        0,
        file.title,
        file.slug,
        "public",
        "valor-lawsuit-folders",
        filename,
        join(targetFilePath, filename),
        mime.lookup(file.storage_path),
        1,
        file.created_on,
        file.created_on,
      ]
    );

    filesProcessed++;
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(
      `${((filesProcessed / totalFilesToDownload) * 100).toFixed(
        2
      )}% [${filename}]`
    );
  }
}

const rl = readline.createInterface({ input, output });

const answer = await rl.question(`
Atenção! 
Esse script irá apagar todos os dados das tabelas valor_lawsuits, valor_lawsuit_folders e todos os attachments vinculados à essas tabelas. 
Deseja continuar? [s/N] `);
rl.close();

if (answer === "s") {
  main();
}

output "role_arn" {
  value = aws_iam_role.this.arn
}

output "queue_url" {
  value = aws_sqs_queue.work.url
}

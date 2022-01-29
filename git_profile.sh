# source $HOME/.git_profile
# git shortcut aliases
alias gs='git status'
alias gc='git commit -m'
alias gps='git push'
alias gpl='git pull'
alias gco='git checkout'
alias gbr='git branch -a'
alias gmerge='git pull && git merge origin/main && git status'
# reset entire branch
alias greset='git reset --hard && git checkout master && git pull'
# adds specified files then displays status
function ga() {
        git add $@
        git status
}
